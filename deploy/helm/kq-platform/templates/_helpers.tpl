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

{{/* Preserve legacy user-chart immutable selectors; previews share a namespace. */}}
{{- define "kq.workloadSelectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
{{- if .Values.preview.enabled }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}
{{- end }}

{{/* PVC ownership must also survive StatefulSet deletion for precise preview cleanup. */}}
{{- define "kq.storageLabels" -}}
{{ include "kq.labels" . }}
{{- if .Values.preview.enabled }}
kuintessence.com/preview-pr: {{ trimPrefix "kq-pr-" .Release.Name | quote }}
{{- end }}
{{- end }}

{{- define "kq.previewStorageAnnotations" -}}
{{- if .Values.preview.enabled }}
kuintessence.com/repository: {{ .Values.preview.repository | quote }}
{{- end }}
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
{{- if and .Values.postgres.enabled .Values.secrets.existingSecret }}
  valueFrom:
    secretKeyRef:
      name: {{ .Values.secrets.existingSecret }}
      key: DATABASE_URL
{{- else if or .Values.postgres.enabled .Values.external.databaseUrl }}
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
Name of the Secret resource that holds JWT_SECRET and optional DB/RustFS passwords.
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
Stable names for the self-hosted RustFS bootstrap resources. The Job suffix changes
only when the bootstrap script or its storage controls change, so upgrades converge
without attempting to mutate an immutable Job spec.
*/}}
{{- define "kq.rustfsBootstrapConfigMapName" -}}
{{ .Release.Name }}-rustfs-bootstrap
{{- end }}

{{- define "kq.rustfsBootstrapName" -}}
{{- $script := .Files.Get "files/bootstrap-object-lock.sh" -}}
{{- $controls := printf "%s|%s|%s|%v|%v|%s|%s" .Values.netdrive.bucket .Values.netdrive.dataMarketStagingBucket .Values.netdrive.dataMarketImmutableBucket .Values.netdrive.dataMarketStagingExpiryDays .Values.netdrive.dataMarketImmutableRetentionDays .Values.netdrive.accessKey .Values.netdrive.bootstrapRevision -}}
{{- $prefix := printf "%s-rustfs-bootstrap" .Release.Name | trunc 54 | trimSuffix "-" -}}
{{ printf "%s-%s" $prefix (sha256sum (printf "%s|%s" $script $controls) | trunc 8) }}
{{- end }}

{{- define "kq.rustfsBootstrapWaitServiceAccountName" -}}
{{ .Release.Name }}-rustfs-bootstrap-wait
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

{{- define "kq.seedName" -}}
{{- $prefix := printf "%s-seed" .Release.Name | trunc 52 | trimSuffix "-" -}}
{{ printf "%s-r%s" $prefix (toString .Release.Revision) }}
{{- end }}

{{/* Shared placement for application and infrastructure Pods. */}}
{{- define "kq.podPlacement" -}}
{{- with .Values.global.nodeSelector }}
nodeSelector: {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.global.imagePullSecrets }}
imagePullSecrets: {{- toYaml . | nindent 2 }}
{{- end }}
{{- end }}

{{- define "kq.webConfig" -}}
{{- $config := .Files.Get "files/web-nginx.conf" -}}
{{- $config = replace "http://server:3000" (printf "http://%s-server:%v" .Release.Name .Values.server.port) $config -}}
{{- $config = replace "http://registry:3100" (printf "http://%s-registry:%v" .Release.Name .Values.registry.port) $config -}}
{{- $config = replace "listen 80;" (printf "listen %v;" .Values.web.port) $config -}}
{{- if .Values.preview.enabled -}}
{{- $config = replace "X-Forwarded-Proto $scheme" "X-Forwarded-Proto https" $config -}}
{{- end -}}
{{ $config }}
{{- end }}

{{- define "kq.image" -}}
{{- $repository := required "image.repository is required" .repository -}}
{{- if .digest -}}
{{- if not (regexMatch "^sha256:[a-f0-9]{64}$" .digest) -}}
{{- fail "image.digest must be a sha256 digest" -}}
{{- end -}}
{{ printf "%s@%s" $repository .digest }}
{{- else -}}
{{ printf "%s:%s" $repository (required "image.tag or image.digest is required" .tag) }}
{{- end -}}
{{- end }}
