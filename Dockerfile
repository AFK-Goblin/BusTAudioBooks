FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV PORT=7000
# Optionally bake the current AudiobookBay domain in (users can still override
# per-install on the configure page):
# ENV ABB_DOMAIN=audiobookbay.lu
EXPOSE 7000
CMD ["node", "src/index.js"]
