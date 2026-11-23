ARG DEV_IMAGE=korekaite-dev:local
FROM ${DEV_IMAGE}
ENV KOREKAITE_DEV_WORKER=evaluation
ENTRYPOINT ["/bin/sh", "/opt/containers/entrypoint.sh"]
CMD ["pnpm", "dev:local"]
