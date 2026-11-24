# ssh-executor: the Cloudflare Container behind deploy-core-worker's SshSession
# Durable Object. A static Go binary on distroless: no shell, no ssh client, no
# package manager in the image.
FROM --platform=linux/amd64 golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o /ssh-executor .

FROM --platform=linux/amd64 gcr.io/distroless/static-debian12:nonroot
COPY --from=build /ssh-executor /ssh-executor
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/ssh-executor"]
