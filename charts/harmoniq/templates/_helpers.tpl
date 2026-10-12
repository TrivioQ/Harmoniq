{{- define "harmoniq.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "harmoniq.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "harmoniq.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}

{{/* Selector labels for one component: registry, web or migrate. */}}
{{- define "harmoniq.selector" -}}
app.kubernetes.io/name: {{ include "harmoniq.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{- define "harmoniq.secretName" -}}
{{- .Values.secrets.existingSecret | default (include "harmoniq.fullname" .) }}
{{- end }}

{{- define "harmoniq.image" -}}
{{- printf "%s:%s" .repository (.root.Values.image.tag | default .root.Chart.AppVersion) }}
{{- end }}

{{/* Environment shared by the registry and the migration job. */}}
{{- define "harmoniq.registryEnv" -}}
- name: NODE_ENV
  value: production
- name: PORT
  value: {{ .Values.registry.port | quote }}
- name: PUBLIC_URL
  value: {{ .Values.urls.registry | quote }}
- name: WEB_ORIGIN
  value: {{ .Values.urls.web | quote }}
{{- with .Values.registry.metricsPort }}
- name: HARMONIQ_METRICS_PORT
  value: {{ . | quote }}
{{- end }}
{{- range $key, $value := .Values.env }}
- name: {{ $key }}
  value: {{ $value | quote }}
{{- end }}
{{- with .Values.registry.extraEnv }}
{{ toYaml . }}
{{- end }}
{{- end }}
