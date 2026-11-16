FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV TZ=Asia/Ho_Chi_Minh

COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts

RUN mkdir -p /app/data/uploads/images /app/data/uploads/attachments /app/data/uploads/submissions /app/data/uploads/exam_files /app/data/backups

EXPOSE 3000

CMD ["node", "src/server.mjs"]
