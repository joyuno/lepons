# 빌드는 alpine, 실행은 scratch. 인터넷에 노출되는 컨테이너에 셸·패키지 관리자·libc를
# 넣지 않아, 공격자가 코드 실행에 성공해도 쓸 도구가 없다. relay는 외부로 접속하지
# 않으므로 CA 인증서도 넣지 않는다.
FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY main.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /relay . && mkdir /logs

FROM scratch
COPY --from=build /relay /relay
# 기록 볼륨(compose.yaml의 logs)은 처음 만들어질 때 이 폴더의 주인을 물려받는다. 그래서
# root가 아닌 65532가 기록을 쓸 수 있다.
COPY --from=build --chown=65532:65532 /logs /logs
USER 65532:65532
EXPOSE 8787
ENTRYPOINT ["/relay"]
