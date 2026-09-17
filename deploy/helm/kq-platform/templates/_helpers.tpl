{{/*
Common labels applied to all resources.
*/}}
{{- define "kq.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "kq-platform.fullname" -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end }}

{{- define "kq-platform.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "kq-platform.labels" -}}
{{- include "kq.labels" . -}}
{{- end }}

{{/*
Resolve database URL: use external if postgres.enabled is false.
*/}}
{{- define "kq.databaseUrl" -}}
{{- if .Values.postgres.enabled -}}
postgres://{{ .Values.postgres.user }}:{{ .Values.postgres.password }}@{{ .Release.Name }}-postgres:5432/{{ .Values.postgres.database }}
{{- else -}}
{{ required "external.databaseUrl is required when postgres.enabled=false" .Values.external.databaseUrl }}
{{- end }}
{{- end }}

{{/* Render DATABASE_URL from values or the operator-managed Secret. */}}
{{- define "kq.databaseEnv" -}}
- name: DATABASE_URL
{{- if or .Values.postgres.enabled .Values.external.databaseUrl }}
  value: {{ include "kq.databaseUrl" . | quote }}
{{- else }}
  valueFrom:
    secretKeyRef:
      name: {{ required "secrets.existingSecret is required when external.databaseUrl is empty" .Values.secrets.existingSecret }}
      key: {{ .Values.external.databaseUrlSecretKey }}
{{- end }}
{{- end }}

{{/*
Resolve Redis URL: use external if redis.enabled is false.
*/}}
{{- define "kq.redisUrl" -}}
{{- if .Values.redis.enabled -}}
redis://{{ .Release.Name }}-redis:6379
{{- else -}}
{{ required "external.redisUrl is required when redis.enabled=false" .Values.external.redisUrl }}
{{- end }}
{{- end }}

{{- define "kq.redisEnv" -}}
- name: REDIS_URL
{{- if or .Values.redis.enabled .Values.external.redisUrl }}
  value: {{ include "kq.redisUrl" . | quote }}
{{- else }}
  valueFrom:
    secretKeyRef:
      name: {{ required "secrets.existingSecret is required when external.redisUrl is empty" .Values.secrets.existingSecret }}
      key: {{ .Values.external.redisUrlSecretKey }}
{{- end }}
{{- end }}

{{/*
Name of the Secret resource that holds JWT_SECRET and optional DB/MinIO passwords.
If secrets.existingSecret is set, use that; otherwise use the release-scoped name.
*/}}
{{- define "kq.secretName" -}}
{{- if .Values.secrets.existingSecret -}}
{{ .Values.secrets.existingSecret }}
{{- else -}}
{{ .Release.Name }}-secrets
{{- end }}
{{- end }}

{{/*
Stable names for the self-hosted MinIO bootstrap resources. The Job suffix changes
only when the bootstrap script or its storage controls change, so upgrades converge
without attempting to mutate an immutable Job spec.
*/}}
{{- define "kq.minioBootstrapConfigMapName" -}}
{{ .Release.Name }}-minio-bootstrap
{{- end }}

{{- define "kq.minioBootstrapName" -}}
{{- $script := .Files.Get "files/bootstrap-object-lock.sh" -}}
{{- $controls := printf "%s|%s|%s|%v|%v|%s|%s" .Values.netdrive.bucket .Values.netdrive.dataMarketStagingBucket .Values.netdrive.dataMarketImmutableBucket .Values.netdrive.dataMarketStagingExpiryDays .Values.netdrive.dataMarketImmutableRetentionDays .Values.netdrive.accessKey .Values.netdrive.bootstrapRevision -}}
{{- $prefix := printf "%s-minio-bootstrap" .Release.Name | trunc 54 | trimSuffix "-" -}}
{{ printf "%s-%s" $prefix (sha256sum (printf "%s|%s" $script $controls) | trunc 8) }}
{{- end }}

{{- define "kq.minioBootstrapWaitServiceAccountName" -}}
{{ .Release.Name }}-minio-bootstrap-wait
{{- end }}

{{/*
Name of the migration Job for this Helm revision. A new revision always runs
the idempotent migration runner before either application starts.
*/}}
{{- define "kq.migrationName" -}}
{{- $prefix := printf "%s-db-migrate" .Release.Name | trunc 52 | trimSuffix "-" -}}
{{ printf "%s-r%s" $prefix (toString .Release.Revision) }}
{{- end }}

{{- define "kq.workloadWaitServiceAccountName" -}}
{{ .Release.Name }}-workload-wait
{{- end }}
