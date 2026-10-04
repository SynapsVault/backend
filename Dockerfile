FROM node:22-alpine
WORKDIR /app

# Node 22 + supabase realtime disabled: 1783293543
COPY . .
RUN npm install --legacy-peer-deps
RUN mkdir -p node_modules/@synapsvault && \
    rm -rf node_modules/@synapsvault/registry-client && \
    cp -r packages/registry-client node_modules/@synapsvault/registry-client
RUN rm -rf dist && npm run build
RUN addgroup -S synapse && adduser -S synapse -G synapse
USER synapse
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s CMD wget -qO- http://localhost:3000/health || exit 1
CMD ["node", "dist/index.js"]