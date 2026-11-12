# The unprivileged nginx image runs as uid 101 and includes the njs module.
FROM nginxinc/nginx-unprivileged:1.30.6-alpine@sha256:f5116ed4606f3eb015dd4a8e28cb9b351476dc0ad4bc6e9f93b19cec130cdf03

USER root
RUN apk upgrade --no-cache
USER 101

# Only these are substituted into the templates, so nginx's own $variables are left alone.
ENV NGINX_ENVSUBST_FILTER="^(PLATFORM_URL|UPSTREAM_URL)$" \
    UPSTREAM_URL=https://earth-search.aws.element84.com \
    REWRITE_BUCKETS='["usgs-landsat"]'

COPY nginx/nginx.conf /etc/nginx/nginx.conf
COPY nginx/templates/ /etc/nginx/templates/
COPY njs/ /etc/nginx/njs/

EXPOSE 8000
