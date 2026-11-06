# Lepons Cockpit

내 PC와 원격 컴퓨터의 AI 코딩 도구(Claude Code, Codex) 세션을 하나의 창에서 열고 관리하는
Electron 데스크톱 앱입니다. 한국어/English/中文 3개 언어를 지원합니다.

화면을 나눠 여러 작업을 나란히 보고, 각 패널에서 AI·터미널·파일을 탭으로 전환할 수 있습니다. 공유 맵으로 컴퓨터 사이에 코드를 공유하고, 설정에서 원격 PC와 AI 도구의 설치·로그인 상태를 관리합니다.

## 요구사항

- Node.js 22 이상 (개발 환경: Node.js 24)
- Windows / macOS / Linux 데스크톱 (Electron GUI 앱이라 헤드리스 서버에서는 실행할 수 없습니다)
- 원격 머신에 연결하려면: 이 컴퓨터의 `~/.ssh`에 키가 있거나 `ssh-agent`가 떠 있어야 하고,
  키·포트 설정은 `~/.ssh/config`에서 읽습니다. 원격에 Claude Code/Codex가 없으면 앱이 자동
  설치를 시도합니다.

## 실행

```sh
cd cockpit
npm install
npm start
```

`npm start`는 `build.mjs`로 `dist/`를 만든 뒤 그 자리에서 Electron 앱을 띄웁니다.

## 그 외 스크립트

| 명령 | 동작 |
|---|---|
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | `src/**/*.test.ts` 전체 (Node 내장 테스트 러너) |
| `npm run build` | 앱은 띄우지 않고 `dist/`(main·preload·renderer·`fonts/`)만 생성 |

## 처음 화면

- 왼쪽 레일의 **＋ 이 컴퓨터의 폴더**로 로컬 폴더를, **＋ 원격 머신**으로 `user@host` 형식의
  SSH 대상을 추가합니다.
- **연결 안내**를 열면 이 컴퓨터의 SSH 공개키, 설치된 에이전트(Claude Code/Codex) 버전, 원격에
  붙여넣을 설정 명령을 실시간으로 검사해 보여줍니다 — 하나씩 손으로 확인할 필요가 없습니다.
- **공유 맵**에서 폴더를 다른 머신 위로 끌어다 놓으면 그 머신이 읽을 수 있게 되고, 선을 클릭하면
  공유가 끊깁니다.
- 왼쪽 하단 드롭다운에서 언어를 한국어/English/中文으로 바꿀 수 있습니다.

## 알아둘 것

- 세션은 **승인 없이 전체 권한으로 시작**합니다. 에이전트가 처음 한 번 경고 후 수락을 요구하는
  것은 정상입니다.
- 그 모드는 `root`로 로그인한 머신에서는 거부됩니다.
- `tmux`가 없는 머신은 연결이 끊기면 실행 중이던 작업이 사라집니다.

## 폰트

UI는 Pretendard Variable(한국어·영어)과 Noto Sans SC 서브셋(중국어, zh 사전에서 실사용하는
글자만 포함)을 내장합니다. CSP가 `font-src 'self' data:`라 외부 CDN을 쓸 수 없어 로컬에
번들했습니다. 라이선스는 `src/renderer/fonts/LICENSE-*.txt` 참고.
