{{- define "autodev.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}{{ .Release.Name | trunc 63 | trimSuffix "-" }}{{- else -}}{{ printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" }}{{- end -}}
{{- end -}}

{{- define "autodev.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "autodev.selector" -}}
app.kubernetes.io/name: {{ .root.Chart.Name }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "autodev.secretName" -}}
{{- default (printf "%s-settings" (include "autodev.fullname" .)) .Values.existingSecret -}}
{{- end -}}

{{- define "autodev.image" -}}
{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}
{{- end -}}

{{/* Settings every backend container gets: the shared ConfigMap and Secret, plus its service name. */}}
{{- define "autodev.envFrom" -}}
envFrom:
  - configMapRef:
      name: {{ include "autodev.fullname" . }}-env
  - secretRef:
      name: {{ include "autodev.secretName" . }}
{{- end -}}

{{- define "autodev.podCommon" -}}
{{- with .Values.imagePullSecrets }}
imagePullSecrets:
  {{- toYaml . | nindent 2 }}
{{- end }}
securityContext:
  {{- toYaml .Values.podSecurityContext | nindent 2 }}
{{- with .Values.nodeSelector }}
nodeSelector:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.tolerations }}
tolerations:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.affinity }}
affinity:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end -}}

{{- define "autodev.ingress" -}}
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {{ include "autodev.fullname" .root }}-{{ .component }}
  labels: {{- include "autodev.labels" .root | nindent 4 }}
  {{- with .cfg.annotations }}
  annotations: {{- toYaml . | nindent 4 }}
  {{- end }}
spec:
  {{- with .cfg.className }}
  ingressClassName: {{ . }}
  {{- end }}
  {{- with .cfg.tls }}
  tls: {{- toYaml . | nindent 4 }}
  {{- end }}
  rules:
    - host: {{ .cfg.host | quote }}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: {{ include "autodev.fullname" .root }}-{{ .component }}
                port:
                  number: {{ .port }}
{{- end -}}
