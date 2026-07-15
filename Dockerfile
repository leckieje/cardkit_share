FROM node:22-slim AS node-deps
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

# Install Node.js runtime (no npm needed — deps already built)
COPY --from=node:22-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=node:22-slim /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm

WORKDIR /app

# Python dependencies
COPY google-sheets/ /app/google-sheets/
COPY sheets-service/requirements.txt /app/sheets-service/requirements.txt
RUN pip install --no-cache-dir -r /app/sheets-service/requirements.txt \
    && pip install --no-cache-dir /app/google-sheets/

# Node dependencies (pre-built)
COPY --from=node-deps /app/server/node_modules /app/server/node_modules

# Application code
COPY server/ /app/server/
COPY sheets-service/app.py sheets-service/ai.py /app/sheets-service/
COPY index.html favicon.ico robots.txt 404.html themes.config.json /app/
COPY scripts/ /app/scripts/
COPY styles/ /app/styles/
COPY views/ /app/views/
COPY modes/ /app/modes/
COPY images/ /app/images/
COPY logo/ /app/logo/
COPY fonts/ /app/fonts/

# Startup script
COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh

ENV NODE_ENV=production
ENV SHEETS_SERVICE_PORT=5050
ENV PORT=8080

EXPOSE 8080

CMD ["/app/start.sh"]
