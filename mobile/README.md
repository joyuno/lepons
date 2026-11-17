# Lepons 휴대폰 앱

PC의 Lepons에 중계 서버(`wss://relay.lepons.app`)로 연결해서, 세션을 보고 답하는 iOS·Android 앱이에요.
Expo(React Native) + TypeScript + Expo Router로 만들었고, 빌드는 EAS 클라우드에서 해요.

## 할 수 있는 것

PC의 휴대폰 웹 페이지(`cockpit/src/phone/page`)와 같은 기능이에요.

- **PC 여러 대**: Lepons를 설치한 PC마다 QR로 한 번씩 연결해 두고 홈 제목(PC 이름)이나 설정의 'PC 바꾸기'에서 바꿔요. 로그인은 PC마다 기억하고, 다른 PC의 알림을 누르면 그 PC로 넘어가요
- **업데이트**: 설정의 '앱 버전'에서 스토어(APK 빌드는 GitHub APK, iPhone TestFlight 빌드는 TestFlight) 업데이트 화면으로 가요
- **홈**: PC 연결 상태, 실행 중·입력 대기·끝난 세션 수, 답을 기다리는 세션, AI별 남은 사용량과 최근 7일 기록, PC 목록
- **세션**: PC별로 묶은 상태 램프 목록. 닫힌 세션은 열고, 열린 세션은 왼쪽으로 밀어 닫거나 끊긴 세션을 다시 연결해요. 워크트리는 원본 아래에 접혀 있다가 첫 탭에 펼쳐지고, 다음 탭에 채팅으로 가요. 아래로 당기면 새로 고쳐요
- **지도**: PC와 폴더, 세션이 이어진 워크플로우 지도. 작업을 누르면 목표·진행·지금 하는 일이 나와요
- **세션 화면**: 대화, 워크플로우, 파일, 터미널
  - 에이전트가 메뉴를 띄우면 번호 버튼으로 답해요
  - 한 줄 입력 칸에서 보내요. 비워 두고 보내면 Enter예요
  - `/`를 치면 명령, `@`를 치면 파일을 골라 넣을 수 있어요
  - 클립 버튼으로 사진(카메라·앨범)이나 파일을 20MB까지 붙여 보내요
  - 멈추기는 두 번 눌러야 Esc를 보내요
  - Ctrl+C, `/exit`, `!` 셸 명령은 앱과 PC가 둘 다 막아요. 세션을 끝낼 때는 세션 탭에서 닫아요
  - 터미널 탭에서는 PC 셸에 명령어를 입력하고 화면 일부를 골라 복사해요
- **파일 보기**: `.md`는 글자로, 그림은 그림으로, 코드는 색을 입혀 보여요. HTML은 스크립트를 끈 웹뷰로 페이지처럼 보여 주고 원문 보기로 바꿀 수 있어요. PDF는 다른 앱으로 넘겨서 열어요

PC가 보내는 값은 화면에 쓰기 전에 모두 형식을 확인해요(`src/phone/validate.ts`).
키와 로그인 토큰은 기기의 보안 저장소(expo-secure-store)에만 둬요.

## 데모 모드

연결 화면의 **데모 둘러보기**를 누르면, 앱 안에 있는 가짜 PC(`src/demo.ts`)로 모든 화면을 써 볼 수 있어요.

- 네트워크를 쓰지 않아요. 아무것도 밖으로 보내지 않아요
- 화면 위쪽에 계속 **데모** 표시가 붙어요
- 가짜 PC도 진짜 PC와 같은 경로·같은 거절 규칙으로 답해요
- 끝내려면 설정(⚙) → **데모 끝내기**를 눌러요

앱 심사 담당자에게는 "연결 화면에서 '데모 둘러보기'를 누르면 PC 없이 모든 화면을 볼 수 있어요"라고 알려 주면 돼요.

## 실행하기

이 PC는 메모리가 적어서 에뮬레이터는 쓰지 않아요. 확인은 아래 명령으로 해요.

```bash
cd mobile
npm install
npx tsc --noEmit                      # 타입 검사
npm test                              # 노드 시험 (규약 시험 값, PC 구현과 교차 시험, 데모)
npx expo-doctor                       # 설정 점검
npx expo export --platform android    # 번들이 만들어지는지 확인 (끝나면 dist 지우기)
```

실제 폰에서 돌려 보려면 개발용 빌드가 필요해요. 카메라·보안 저장소 같은 네이티브 모듈이 있어서 Expo Go로는 안 돼요.

```bash
npx eas-cli@latest build --profile development --platform android   # 또는 ios
npx expo start --dev-client                                          # 폰에 개발용 빌드를 깐 뒤
```

## EAS로 빌드하기

Expo 계정 `joyuno`로 로그인돼 있어야 해요(`npx eas-cli@latest whoami`).

| 프로필 | 용도 |
|---|---|
| `development` | 개발용 빌드 (expo-dev-client) |
| `preview` | 내부 배포용 (안드로이드는 APK) |
| `production` | 스토어 제출용 |

```bash
npx eas-cli@latest build --profile preview --platform android
npx eas-cli@latest build --profile production --platform all
npx eas-cli@latest submit --platform ios       # 스토어 제출은 계정 확인 뒤에
```

## 입력 대기 알림 (푸시)

PC에 로그인하면 앱이 알림 권한을 물어보고, Expo 푸시 토큰을 중계로 PC에 보내요(`POST /api/push-token`).
세션이 입력 대기로 바뀌면 PC가 Expo 푸시 서비스(`https://exp.host/--/api/v2/push/send`)로 알림을 보내요.

- 알림에는 "Lepons"와 "{PC 이름}의 세션이 입력을 기다려요"만 담겨요. 화면 내용·폴더 이름은 담지 않아요
- 알림을 누르면 그 세션 화면이 열려요
- 안드로이드 알림 채널은 `waiting`(입력 대기)이에요
- 설정에서 **입력 대기 알림**을 끄면 PC가 토큰을 지워요. 페어 해제해도 지워요
- EAS 프로젝트 ID는 `app.json`의 `extra.eas.projectId`에 있어요

진짜 폰에 알림이 오게 하려면 주인이 한 번 해 둬야 할 일이 있어요. 이 저장소에서는 하지 않았어요.

1. **안드로이드**: Firebase 프로젝트를 만들고 `app.lepons.mobile` 앱을 추가한 뒤, 서비스 계정 키(FCM V1, JSON)를 받아 EAS에 올려요.
   `npx eas-cli@latest credentials` → Android → production → Google Service Account → FCM V1 키 업로드
2. **iOS**: Apple 개발자 계정으로 로그인한 상태에서 `npx eas-cli@latest credentials` → iOS → Push Notifications 키를 고르면 EAS가 APNs 키를 만들어 줘요
3. 그다음 새로 빌드해요. 알림 설정은 네이티브라서 기존 빌드에는 들어가지 않아요

## 폴더

- `src/app/`: 화면(Expo Router). `(tabs)/`가 홈·세션·지도 탭이에요
- `src/relay/`: 중계 연결 규약과 클라이언트 (`relay/README.md`)
- `src/phone/`: PC 쪽 휴대폰 코드를 그대로 옮겨 온 파일들이에요. `phone.test.ts`가 원본과 달라지면 실패해요
- `src/demo.ts`: 데모용 가짜 PC
- `src/connection.tsx`: 연결, 로그인, 실시간 이벤트, 데모 전환
