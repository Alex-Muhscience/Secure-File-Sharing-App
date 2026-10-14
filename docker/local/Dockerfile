FROM node:24-alpine
WORKDIR /app
COPY public ./public
COPY docker/local/preview.cjs ./preview.cjs
USER node
EXPOSE 3000
CMD ["node", "preview.cjs"]
