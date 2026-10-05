# Multi-stage build for optimized production image
FROM node:22-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Build application
COPY . .
RUN mkdir -p node_modules/@synapsvault && \
    rm -rf node_modules/@synapsvault/registry-client && \
    cp -r packages/registry-client node_modules/@synapsvault/registry-client
RUN npm run build

# Runtime stage
FROM node:22-alpine

WORKDIR /app

# Copy only production artifacts
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json .

# Create non-root user for security
RUN addgroup -S synapse && adduser -S synapse -G synapse
USER synapse

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s \
  CMD wget -qO- http://localhost:3000/health || exit 1

# Start application
CMD ["node", "dist/index.js"]