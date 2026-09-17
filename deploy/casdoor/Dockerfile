FROM casbin/casdoor:latest

USER root
ENV CASDOOR_DEFAULT_ORIGIN=http://casdoor.localhost:15180

COPY app.conf.template /conf/app.conf.template
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
USER 1000
