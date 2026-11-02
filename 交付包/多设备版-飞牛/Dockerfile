FROM node:20-alpine

WORKDIR /app
COPY server.js ./

ENV PORT=8080
ENV DATA_DIR=/data
ENV WEB_DIR=/app/web
ENV TZ=Asia/Shanghai

RUN mkdir -p /data /app/web

EXPOSE 8080

HEALTHCHECK --interval=60s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8080/api/health > /dev/null || exit 1

CMD ["node", "server.js"]
