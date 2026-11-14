# ImageStoria: one image holding the server and the built front end.
# Postgres runs beside it (see docker-compose.yml).

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# Search by meaning runs a small text model on the CPU with ONNX Runtime. Its GPU libraries are not wanted here.
ENV ONNXRUNTIME_NODE_INSTALL_CUDA=skip
RUN npm ci
COPY . .
# After the build: drop what only the build needed, and ONNX Runtime's files for other systems.
RUN npm run build && npm prune --omit=dev  && find node_modules/onnxruntime-node/bin -mindepth 2 -maxdepth 2 -type d ! -name linux -exec rm -rf {} +  && rm -rf node_modules/onnxruntime-web/dist/*.map

FROM node:22-bookworm-slim
# ffmpeg reads videos and takes their poster frame. tini passes stop signals to Node so shutdown is clean.
# pg_dump for the scheduled backup must be the database's version or newer. Debian 12 ships 15, so the client
# comes from the PostgreSQL project's own repository: version 17 dumps servers from 9.2 to 17.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
 && echo 'deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main' > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-17 \
 && apt-get purge -y curl && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg tini fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0 DATA_DIR=/data
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle
# /data holds uploads when STORAGE_DRIVER=local, and short-lived working files in every setup.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/server/index.js"]
