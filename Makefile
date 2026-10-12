GOBIN ?= $(shell go env GOPATH)/bin
PROTOS := $(shell find proto -name '*.proto')

.PHONY: build test test-short lint proto up worker-mock

build:
	go build -o bin/ ./cmd/...

test:
	go test -race ./...

test-short:  ## 跳过需要真实进程的端到端测试
	go test -race -short ./...

lint:
	go vet ./...
	test -z "$$(gofmt -l cmd internal test workers)"

proto:  ## 需要 protoc、protoc-gen-go、protoc-gen-go-grpc
	PATH="$(GOBIN):$$PATH" protoc -I proto \
		--go_out=. --go_opt=module=github.com/Appletree24/Detroit \
		--go-grpc_out=. --go-grpc_opt=module=github.com/Appletree24/Detroit \
		$(PROTOS)

up: build  ## 单机模式启动控制面（SQLite + 本地文件）
	mkdir -p .detroit
	./bin/controller -db .detroit/detroit.db

worker-mock: build
	./bin/detroit worker mock
