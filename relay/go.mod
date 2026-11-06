// Docker 빌드 범위를 relay/ 폴더로 한정하기 위해 자체 모듈로 둔다.
module lepons/relay

go 1.25

require github.com/coder/websocket v1.8.15
