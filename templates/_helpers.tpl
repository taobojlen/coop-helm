{{- define "coop.name" -}}
{{- $name := printf "%s-coop" .Release.Name -}}
{{- if gt (len $name) 40 -}}
{{- printf "%s-%s" ($name | trunc 31 | trimSuffix "-") ($name | sha256sum | trunc 8) -}}
{{- else -}}
{{- $name -}}
{{- end -}}
{{- end -}}

{{- define "coop.labels" -}}
app.kubernetes.io/name: coop
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | quote }}
{{- end -}}

{{- define "coop.host" -}}
{{- $service := index .root.Values .service -}}
{{- if $service.enabled -}}
{{- printf "%s-%s" (include "coop.name" .root) .service -}}
{{- else -}}
{{- required (printf "%s.host is required when %s.enabled=false" .service .service) $service.host -}}
{{- end -}}
{{- end -}}

{{- define "coop.secret" -}}
valueFrom:
  secretKeyRef:
    name: {{ required "secrets.existingSecret is required" .root.Values.secrets.existingSecret | quote }}
    key: {{ index .root.Values.secrets.keys .key | quote }}
{{- end -}}

{{- define "coop.podSecurity" -}}
automountServiceAccountToken: false
terminationGracePeriodSeconds: 90
{{- with .Values.imagePullSecrets }}
imagePullSecrets:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end -}}

{{- define "coop.containerSecurity" -}}
allowPrivilegeEscalation: false
seccompProfile:
  type: RuntimeDefault
capabilities:
  drop: [ALL]
{{- end -}}

{{- define "coop.storage" -}}
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: {{ include "coop.name" .root }}-{{ .service }}
  labels:
    {{- include "coop.labels" .root | nindent 4 }}
  annotations:
    helm.sh/resource-policy: keep
spec:
  accessModes: [ReadWriteOnce]
  {{- $storage := (index .root.Values .service).storage }}
  {{- if ne $storage.className nil }}
  storageClassName: {{ $storage.className | quote }}
  {{- end }}
  resources:
    requests:
      storage: {{ $storage.size }}
{{- end -}}
