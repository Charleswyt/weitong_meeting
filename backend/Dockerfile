# syntax=docker/dockerfile:1
#
# 一份 Dockerfile 出两个单架构产物（不发多架构 manifest list）：
#   docker build --platform linux/amd64 -t conference-backend:dev --load .        # 开发机自测
#   docker build --platform linux/arm64 -t conference-backend:edge -o type=docker,dest=conference-edge.tar .
# 现场是 RK3588（aarch64），只认 arm64 那一份；见 shared/TECH_STACK.md「上边端的镜像必须是 arm64」。

# 编译阶段**钉在构建机自己的架构**上：Go 侧无 CGO（SQLite 走 glebarez 纯 Go 驱动，
# 已实测 CGO_ENABLED=0 GOARCH=arm64 出的是 statically linked 二进制），
# 所以交叉过去只是换 GOARCH，不必让 QEMU 模拟整个编译过程 —— 两个架构都是原生速度。
FROM --platform=$BUILDPLATFORM golang:1.27-alpine AS build
ARG TARGETOS
ARG TARGETARCH
# 开发机直连 proxy.golang.org 是被拒的（实测 dial tcp …:443 connection refused），
# 所以默认走国内可达的镜像；内网有自建代理就覆盖这个 ARG，离线机器上根本不需要构建。
ARG GOPROXY=https://goproxy.cn,direct
ARG GOSUMDB=sum.golang.google.cn
ENV GOPROXY=$GOPROXY
ENV GOSUMDB=$GOSUMDB
WORKDIR /src

# 先只喂依赖清单，源码改动时这一层缓存才不会失效；
# /go/pkg/mod 挂成 BuildKit 缓存，arm64 与 amd64 两次构建共用同一份下载结果。
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download

COPY . .
ENV CGO_ENABLED=0
ENV GOOS=$TARGETOS
ENV GOARCH=$TARGETARCH
RUN --mount=type=cache,target=/go/pkg/mod \
    go build -trimpath -ldflags="-s -w" -o /out/conference .

# 运行阶段必须带 tzdata：internal/cmd/config.go 用 server.timezone 把进程时区钉在东八区，
# 而 gtime.SetTimeZone 底层是 time.LoadLocation —— 镜像里没有 /usr/share/zoneinfo 就直接 Fatalf 起不来。
# 二进制没内嵌 time/tzdata，所以这层依赖是必需的，不是"顺手装个包"。
# ca-certificates 同理：三方控制面走 HTTPS，缺 CA 池会撞 x509 unknown authority。
FROM alpine:3.24
RUN apk add --no-cache ca-certificates tzdata
WORKDIR /app

COPY --from=build /out/conference /app/conference
# 建库脚本：schema 真源，口令列是空占位，不含凭据。
# 里面带着字典表、部门、6 个测试账号与默认设置，所以"字典等表给到现场"这一步
# 不需要额外传东西 —— 跑一次建库就有了。
COPY manifest/sql/sqlite_create.sql /app/manifest/sql/sqlite_create.sql
# 口令种子：**刻意打进镜像**。那 6 个是测试账号、不涉及安全，烘进来现场就少一个交付件、
# 少一步"漏灌就登不进去"。这份文件本身仍被 gitignore，不进版本库；
# 代价是镜像构建不再是"干净 clone 就能跑"，得有它在原地。
# 三方口令列由它一起注入（THIRD_PARTY_PASSWORD 必须明文，要原样发给三方换令牌）。
COPY manifest/sql/seed-credentials.sql /app/manifest/sql/field-credentials.sql
# 内置一份默认配置，让挂载变成可选项：不挂也能起（起不来只是没数据，不是没配置）。
# 这份默认里 jwt.secret 是占位串、SM2 私钥留空（走代码内置演示值），两者启动时都会 WARN。
# 正式部署仍应挂自己的 config.yaml —— 占位密钥等于谁都能伪造令牌。
COPY manifest/config/config.yaml.example /app/manifest/config/config.yaml
# 库文件默认落这里（连接串是相对路径 data/conference.db）。空目录也要存在，
# 否则 SQLite 打不开文件；正式部署把它整体挂成卷。
RUN mkdir -p /app/data

# 8082：REST + /ws/v1/meeting。端口预算登记在 shared/contracts/edge-to-edge/host-baseline.md
# 现场要换对外端口只需 -p <新端口>:8082，容器内监听地址不用动。
EXPOSE 8082

ENTRYPOINT ["/app/conference"]
