FROM nervos/ckb:v0.210.0@sha256:35a5c23ebceb9593fe937ddf697ba68d170fcb37c931fbfbd606686d5c753ae8

USER root
COPY deploy/docker/ckb-dev-entrypoint.sh /usr/local/bin/ckb-automata-entrypoint
RUN sed -i 's/\r$//' /usr/local/bin/ckb-automata-entrypoint \
  && chmod 0555 /usr/local/bin/ckb-automata-entrypoint
USER ckb

ENTRYPOINT ["/usr/local/bin/ckb-automata-entrypoint"]
