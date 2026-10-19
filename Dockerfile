FROM ghcr.io/cloud-cli/image-node:latest
WORKDIR /home/app
COPY --chown=1000:1000 package.json package-lock.json server.js index.html ./
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
