{{- define "coop.otelEnv" -}}
{{- $config := .root.Values.observability }}
- name: NODE_OPTIONS
  value: '--require=/opt/coop-otel-config/bootstrap.cjs --experimental-loader=/opt/coop-otel/node_modules/@opentelemetry/instrumentation/hook.mjs'
- name: HONEYCOMB_API_KEY
  valueFrom:
    secretKeyRef:
      name: {{ required "observability.existingSecret is required" $config.existingSecret | quote }}
      key: {{ $config.apiKeySecretKey | quote }}
- name: OTEL_EXPORTER_OTLP_HEADERS
  value: 'x-honeycomb-team=$(HONEYCOMB_API_KEY)'
- name: OTEL_EXPORTER_OTLP_ENDPOINT
  value: {{ $config.endpoint | quote }}
- name: OTEL_EXPORTER_OTLP_PROTOCOL
  value: grpc
- name: OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE
  value: delta
- name: OTEL_METRIC_EXPORT_INTERVAL
  value: {{ $config.metricExportIntervalMs | quote }}
- name: OTEL_TRACES_SAMPLER
  value: parentbased_traceidratio
- name: OTEL_TRACES_SAMPLER_ARG
  value: {{ (index $config .component).traceSampleRatio | quote }}
- name: OTEL_LOGS_EXPORTER
  value: none
- name: OTEL_PROPAGATORS
  value: tracecontext,baggage
- name: OTEL_RESOURCE_ATTRIBUTES
  value: {{ printf "deployment.environment.name=%s,k8s.namespace.name=%s,service.namespace=%s" $config.environment .root.Release.Namespace .root.Release.Name | quote }}
{{- end -}}
