# syntax=docker/dockerfile:1
#
# 前端两个单架构产物，与后端同一套做法：
#   docker build --platform linux/amd64 -t conference-frontend:dev .
#   docker build --platform linux/arm64 -t conference-frontend:edge -o type=docker,dest=../backend/dist/conference-frontend-edge-arm64.tar .
# 静态资源与架构无关，但 nginx 底是分架构的，所以现场那份仍要显式 --platform linux/arm64。

FROM --platform=$BUILDPLATFORM node:24-alpine AS build
# 开发机直连 npm 官方源不稳，默认走国内镜像；内网有源就 --build-arg 覆盖。
ARG NPM_REGISTRY=https://registry.npmmirror.com
ARG PNPM_VERSION=12.11.2
WORKDIR /src

RUN npm config set registry ${NPM_REGISTRY} \
 && npm install -g pnpm@${PNPM_VERSION}

# 先只喂清单，源码改动时依赖层缓存不失效
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

COPY . .
# build 脚本是 `vue-tsc && vite build` —— 类型检查不过就出不了包，这是刻意的门
RUN pnpm build

FROM nginx:1.30.5-alpine
# 反代目标。compose 里天然叫 backend；单独部署时用 -e BACKEND_UPSTREAM=<后端IP:端口> 覆盖。
# 必须在这里给默认值：nginx 官方镜像只对"已定义的环境变量"做替换，没定义就会把
# 模板里的占位符原样留下，配置直接不合法。
ENV BACKEND_UPSTREAM=backend:8082
# 页面路由交给 SPA 兜底，接口/媒体资产/WebSocket 全部反代到后端，
# 于是浏览器看到的是同一个源 —— 分享链接由前端按浏览器地址拼，同源才拼得对。
COPY --from=build /src/dist /usr/share/nginx/html
# 用 .template 结尾：官方 nginx 镜像启动时会拿环境变量渲染它
COPY docker/nginx.conf.template /etc/nginx/templates/default.conf.template
EXPOSE 80
