"""Exercise the rendered OTTL filter with synthetic OTLP data; no Honeycomb key."""
import json
from pathlib import Path
import subprocess
import tempfile
import time
import urllib.request
import yaml

rendered = subprocess.check_output([
    'helm', 'template', 'coop-k8s-health', 'opentelemetry-collector',
    '--repo', 'https://open-telemetry.github.io/opentelemetry-helm-charts',
    '--version', '0.178.1', '-n', 'coop', '-f', 'observability/workload-health-values.yaml',
], text=True)
resources = list(yaml.safe_load_all(rendered))
config = yaml.safe_load(next(r for r in resources if r and r['kind'] == 'ConfigMap')['data']['relay'])
assert set(config['service']['pipelines']) == {'metrics', 'logs'}
assert 'x-honeycomb-dataset' not in config['exporters']['otlp_grpc/honeycomb']['headers']
config['receivers'] = {'otlp': {'protocols': {'http': {'endpoint': '0.0.0.0:4318'}}}}
config['exporters'] = {'debug': {'verbosity': 'detailed'}}
config['service']['pipelines']['metrics']['receivers'] = ['otlp']
config['service']['pipelines']['metrics']['exporters'] = ['debug']
config['service']['pipelines']['logs']['receivers'] = ['otlp']
config['service']['pipelines']['logs']['exporters'] = ['debug']
config['processors']['batch']['timeout'] = '100ms'
config['service']['telemetry'] = {'metrics': {'level': 'none'}}
config['extensions']['health_check']['endpoint'] = '0.0.0.0:13133'
names = ['k8s.container.restarts', 'k8s.pod.phase',
 'k8s.daemonset.current_scheduled_nodes', 'k8s.daemonset.desired_scheduled_nodes',
 'k8s.statefulset.desired_pods', 'k8s.statefulset.ready_pods',
 'k8s.deployment.available', 'k8s.deployment.desired',
 'k8s.job.failed_pods', 'k8s.cronjob.active_jobs']

def anyvalue(value):
    if isinstance(value, dict):
        return {'kvlistValue': {'values': [{'key': k, 'value': anyvalue(v)} for k,v in value.items()]}}
    if isinstance(value, int):
        return {'intValue': str(value)}
    return {'stringValue': value}

def event(kind, name, reason, severity):
    body = {'type': 'ADDED', 'object': {
        'metadata': {'namespace': 'coop'},
        'involvedObject': {'kind': kind, 'name': name, 'namespace': 'coop'},
        'reason': reason, 'type': severity, 'count': 1,
    }}
    return {'timeUnixNano': str(time.time_ns()), 'body': anyvalue(body)}

def metrics(namespace, pod):
    return {'resource': {'attributes': [
        {'key': 'k8s.namespace.name', 'value': {'stringValue': namespace}},
        {'key': 'k8s.pod.name', 'value': {'stringValue': pod}},
    ]}, 'scopeMetrics': [{'metrics': [
        {'name': name, 'gauge': {'dataPoints': [{'asDouble': 1, 'timeUnixNano': str(time.time_ns())}]}}
        for name in names + ['k8s.pod.network.io']
    ]}]}

with tempfile.TemporaryDirectory() as directory:
    path = Path(directory) / 'collector.yaml'
    path.write_text(yaml.safe_dump(config))
    container = subprocess.check_output([
        'docker', 'run', '-d', '-p', '127.0.0.1::4318', '-v', f'{path}:/config.yaml:ro',
        'ghcr.io/open-telemetry/opentelemetry-collector-releases/opentelemetry-collector-k8s:0.163.2',
        '--config=/config.yaml',
    ], text=True).strip()
    try:
        endpoint = subprocess.check_output(['docker', 'port', container, '4318'], text=True).strip()
        payload = json.dumps({'resourceMetrics': [
            metrics('coop', 'coop-coop-api-proof'),

            metrics('kube-system', 'coop-coop-api-outsider'),

        ]}).encode()
        for attempt in range(30):
            try:
                request = urllib.request.Request(f'http://{endpoint}/v1/metrics', data=payload,
                                                 headers={'Content-Type': 'application/json'})
                with urllib.request.urlopen(request, timeout=2) as response:
                    assert response.status == 200
                break
            except OSError:
                if attempt == 29:
                    raise
                time.sleep(0.2)
        log_payload = json.dumps({'resourceLogs': [{'scopeLogs': [{'logRecords': [
            event('Pod', 'normal-pod-proof', 'Started', 'Normal'),
            event('Pod', 'warning-pod-proof', 'BackOff', 'Warning'),
            event('Node', 'node-proof', 'NodeNotReady', 'Warning'),
        ]}]}]}).encode()
        request = urllib.request.Request(f'http://{endpoint}/v1/logs', data=log_payload,
                                         headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=3) as response:
            assert response.status == 200
        for attempt in range(30):
            logs = subprocess.run(['docker', 'logs', container], capture_output=True, text=True)
            output = logs.stdout + logs.stderr
            if 'coop-coop-api-proof' in output and 'SeverityText: Warning' in output:
                break
            time.sleep(0.2)
        assert 'coop-coop-api-proof' in output, output
        for name in names:
            assert f'Name: {name}' in output, output
        for excluded in ['coop-coop-api-outsider', 'Name: k8s.pod.network.io']:
            assert excluded not in output, output
        for field in ['reason: Str(Started)', 'reason: Str(BackOff)',
                      'k8s.pod.name: Str(normal-pod-proof)', 'k8s.pod.name: Str(warning-pod-proof)',
                      'k8s.node.name: Str(node-proof)', 'SeverityText: Normal', 'SeverityText: Warning']:
            assert field in output, output
        print('Passed: workload metric allowlist, namespace exclusion, and normal/warning pod/node event mappings.')
    finally:
        subprocess.run(['docker', 'rm', '-f', container], check=True, capture_output=True)
