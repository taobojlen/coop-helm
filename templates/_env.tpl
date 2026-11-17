{{- define "coop.env" -}}
{{- $pg := include "coop.host" (dict "root" . "service" "postgresql") -}}
{{- $values := dict
  "NODE_ENV" "production"
  "PORT" "8080"
  "OTEL_SERVICE_NAME" (default "coop" .otelServiceName)
  "UI_URL" .Values.externalUrl
  "DATABASE_HOST" $pg
  "DATABASE_READ_ONLY_HOST" (default $pg .Values.postgresql.readHost)
  "DATABASE_PORT" .Values.postgresql.port
  "DATABASE_NAME" .Values.postgresql.database
  "DATABASE_USER" .Values.postgresql.username
  "DATABASE_SSL" .Values.postgresql.ssl
  "DATABASE_POOL_MAX" "5"
  "DATABASE_READ_POOL_MAX" "5"
  "API_SERVER_DATABASE_HOST" $pg
  "API_SERVER_DATABASE_PORT" .Values.postgresql.port
  "API_SERVER_DATABASE_NAME" .Values.postgresql.database
  "API_SERVER_DATABASE_USER" .Values.postgresql.username
  "API_SERVER_DATABASE_SSL" .Values.postgresql.ssl
  "API_SERVER_DATABASE_MAINTENANCE_NAME" .Values.postgresql.maintenanceDatabase
  "SCYLLA_ENABLED" "true"
  "SCYLLA_HOSTS" (include "coop.host" (dict "root" . "service" "scylla"))
  "SCYLLA_PORT" .Values.scylla.port
  "SCYLLA_USERNAME" .Values.scylla.username
  "SCYLLA_LOCAL_DATACENTER" .Values.scylla.datacenter
  "SCYLLA_KEYSPACE" .Values.scylla.keyspace
  "SCYLLA_REPLICATION_CLASS" "SimpleStrategy"
  "SCYLLA_REPLICATION_FACTOR" .Values.scylla.replicationFactor
  "SCYLLA_COMPACTION_STRATEGY" "SizeTieredCompactionStrategy"
  "SCYLLA_HAS_ENTERPRISE_FEATURES" "false"
  "CLICKHOUSE_HOST" (include "coop.host" (dict "root" . "service" "clickhouse"))
  "CLICKHOUSE_PORT" .Values.clickhouse.port
  "CLICKHOUSE_DATABASE" .Values.clickhouse.database
  "CLICKHOUSE_USERNAME" .Values.clickhouse.username
  "CLICKHOUSE_PROTOCOL" .Values.clickhouse.protocol
  "CLICKHOUSE_MAX_BYTES_BEFORE_EXTERNAL_GROUP_BY" "268435456"
  "CLICKHOUSE_MAX_BYTES_BEFORE_EXTERNAL_SORT" "268435456"
  "WAREHOUSE_ADAPTER" "clickhouse"
  "ANALYTICS_ADAPTER" "clickhouse"
  "REDIS_USE_CLUSTER" "false"
  "REDIS_HOST" (include "coop.host" (dict "root" . "service" "redis"))
  "REDIS_PORT" .Values.redis.port
  "REDIS_USER" .Values.redis.username
  "REDIS_TLS" .Values.redis.tls
  "NCMEC_ENV" "test"
  "LOG_REQUEST_BODY" "false"
  "EXPOSE_SENSITIVE_IMPLEMENTATION_DETAILS_IN_ERRORS" "false"
  "ALLOW_USER_INPUT_LOCALHOST_URIS" "false"
  "ITEM_QUEUE_TRAFFIC_PERCENTAGE" "1"
-}}
{{- range $name, $value := $values }}
- name: {{ $name }}
  value: {{ $value | toString | quote }}
{{- end }}
{{- range $name, $key := dict "SESSION_SECRET" "session" "DATABASE_PASSWORD" "postgresql" "API_SERVER_DATABASE_PASSWORD" "postgresql" "SCYLLA_PASSWORD" "scylla" "CLICKHOUSE_PASSWORD" "clickhouse" "REDIS_PASSWORD" "redis" }}
- name: {{ $name }}
  {{- include "coop.secret" (dict "root" $ "key" $key) | nindent 2 }}
{{- end }}
{{- end -}}
