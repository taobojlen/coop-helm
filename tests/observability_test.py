"""Rendered Kubernetes contract; requires Helm and PyYAML, no cluster."""
import subprocess
import unittest

import yaml


class Observability(unittest.TestCase):
    def render(self, *settings, success=True):
        command = ['helm', 'template', 'coop', '.', '--is-upgrade', '-f', 'values-local.yaml']
        for setting in settings:
            command += ['--set-json' if '.traceSampleRatio=' in setting else '--set', setting]
        result = subprocess.run(command, capture_output=True, text=True)
        if not success:
            self.assertNotEqual(result.returncode, 0)
            return result.stderr
        self.assertEqual(result.returncode, 0, result.stderr)
        return [r for r in yaml.safe_load_all(result.stdout) if r]

    def enabled(self, *settings, **kwargs):
        return self.render('observability.enabled=true',
                           'observability.instrumentationImage=example.com/otel:tested',
                           'observability.existingSecret=honeycomb', *settings, **kwargs)

    def test_disabled_has_no_injection(self):
        for resource in self.render():
            if resource['kind'] == 'Deployment':
                spec = resource['spec']['template']['spec']
                self.assertNotIn('otel-dependencies', str(spec))
                self.assertNotIn('HONEYCOMB_API_KEY', str(spec))

    def test_only_api_and_worker_have_distinct_sampling_and_secrets(self):
        resources = self.enabled('observability.api.traceSampleRatio=0.1',
                                 'observability.worker.traceSampleRatio=0.02')
        for resource in resources:
            if resource['kind'] != 'Deployment':
                continue
            spec = resource['spec']['template']['spec']
            component = resource['spec']['template']['metadata']['labels']['app.kubernetes.io/component']
            env_list = spec['containers'][0].get('env', [])
            env = {v['name']: v for v in env_list}
            self.assertEqual(len(env), len(env_list), 'duplicate env names')
            if component not in ['api', 'worker']:
                self.assertNotIn('NODE_OPTIONS', env)
                continue
            self.assertEqual(env['OTEL_SERVICE_NAME']['value'], f'coop-{component}')
            self.assertEqual(env['OTEL_TRACES_SAMPLER_ARG']['value'], '0.1' if component == 'api' else '0.02')
            self.assertEqual(env['HONEYCOMB_API_KEY']['valueFrom']['secretKeyRef'], {'name': 'honeycomb', 'key': 'api-key'})
            names = [v['name'] for v in env_list]
            self.assertLess(names.index('HONEYCOMB_API_KEY'), names.index('OTEL_EXPORTER_OTLP_HEADERS'))
            self.assertEqual(spec['securityContext']['fsGroup'], 1001)
            self.assertEqual(len(spec['initContainers']), 1)

    def test_invalid_settings_fail(self):
        for setting in ['observability.api.traceSampleRatio=1.1',
                        'observability.worker.traceSampleRatio=-0.1',
                        'observability.existingSecret=',
                        'observability.instrumentationImage=',
                        'extraEnv[0].name=NODE_OPTIONS',
                        'observability.endpoint=http://example.com']:
            with self.subTest(setting=setting):
                self.enabled(setting, success=False)

    def test_bootstrap_has_no_instrumentation(self):
        resources = self.enabled('bootstrapOnly=true')
        self.assertFalse(any(r['metadata']['name'].endswith('-otel') for r in resources))


if __name__ == '__main__':
    unittest.main()
