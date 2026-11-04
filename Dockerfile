FROM node:22-alpine
# curl — для проверки состояния контейнера (её делает хостинг, например Timeweb App Platform)
RUN apk add --no-cache curl
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY webapp ./webapp
COPY scripts ./scripts
COPY data ./data
# каталог, фото и заказы — в томе /data, переживают обновления
ENV DATA_DIR=/data NODE_ENV=production PORT=8080
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 CMD curl -fsS http://127.0.0.1:8080/health || exit 1
CMD ["node", "src/start.js"]
