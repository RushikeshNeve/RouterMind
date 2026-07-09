FROM node:20-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/dashboard/package.json apps/dashboard/package.json
COPY packages packages
RUN npm ci

FROM deps AS build
COPY . .
ARG NEXT_PUBLIC_ROUTEMIND_API_URL=http://localhost:3000
ENV NEXT_PUBLIC_ROUTEMIND_API_URL=$NEXT_PUBLIC_ROUTEMIND_API_URL
RUN npm run build -w @routemind/dashboard

FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/dashboard/package.json apps/dashboard/package.json
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/apps/dashboard/.next ./apps/dashboard/.next
COPY --from=build /app/apps/dashboard/next.config.mjs ./apps/dashboard/next.config.mjs
EXPOSE 3002
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD wget -qO- http://127.0.0.1:3002/dashboard || exit 1
CMD ["npm", "run", "start", "-w", "@routemind/dashboard"]
