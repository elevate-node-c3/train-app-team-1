# Build a service with an app name from nest-cli.json:
#   docker build --build-arg APP=gateway -t train-app/gateway .

FROM node:24-alpine AS deps
WORKDIR /usr/src/app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-alpine AS build
WORKDIR /usr/src/app
ARG APP
RUN test -n "$APP" || (echo "APP build arg is required (e.g. --build-arg APP=gateway)" >&2; exit 1)
COPY --from=deps /usr/src/app/node_modules ./node_modules
COPY . .
# Shared libraries put the entry at dist/apps/<APP>/src/main.js.
# Check it here so broken images fail during the build.
RUN npx nest build "$APP" && mkdir -p dist/libs/contracts/src/proto && cp libs/contracts/src/proto/*.proto dist/libs/contracts/src/proto/ && test -f "dist/apps/$APP/src/main.js"

# The seeder runs only with the Compose seed profile.
# Build apps separately: Nest rewrites aliases and clears dist each time.
FROM deps AS build-identity
WORKDIR /usr/src/app
COPY . .
RUN npx nest build identity

FROM build AS seeder
WORKDIR /usr/src/app
# Merge identity and catalog output for both seeds.
COPY --from=build-identity /usr/src/app/dist ./dist
RUN test -f dist/apps/catalog/src/database/seeds/catalog.seed.js \
 && test -f dist/apps/identity/src/database/seeds/staff-accounts.seed.js \
 && test -f dist/libs/contracts/src/index.js \
 && ! grep -rq "from '@app/" dist/apps dist/libs
USER node
CMD ["node", "scripts/seed-all.mjs"]

FROM node:24-alpine AS runtime
WORKDIR /usr/src/app
ENV NODE_ENV=production
# Keep package.json so Node treats the output as ESM.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /usr/src/app/dist ./dist
COPY libs/contracts/src/proto ./libs/contracts/src/proto

# Use ENV and a shell so CMD can read the app name.
ARG APP
ENV APP=${APP}
ENV PORT=3000

USER node
EXPOSE 3000
CMD ["sh", "-c", "node dist/apps/$APP/src/main"]
