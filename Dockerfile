FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY webapp ./webapp
COPY scripts ./scripts
COPY data ./data
# каталог, фото и заказы — в томе /data, переживают обновления
ENV DATA_DIR=/data NODE_ENV=production
VOLUME /data
EXPOSE 8080
CMD ["node", "src/start.js"]
