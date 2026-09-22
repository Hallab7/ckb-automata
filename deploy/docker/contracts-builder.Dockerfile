FROM rust:1.93.1-bookworm@sha256:7c4ae649a84014c467d79319bbf17ce2632ae8b8be123ac2fb2ea5be46823f31

RUN rustup target add riscv64imac-unknown-none-elf

WORKDIR /work

ENV CARGO_INCREMENTAL=0 \
    SOURCE_DATE_EPOCH=0

ENTRYPOINT ["cargo", "build-contracts", "--locked"]
