# lepons.app 정적 사이트

Lepons의 공개 홈이에요. 소개(`index.html`, 영어는 `en/index.html`)·개인정보 처리방침(`privacy.html`)·이용약관(`terms.html`)·지원(`support.html`)이 있어요. 빌드 단계 없는 HTML/CSS이고, 외부 글꼴·스크립트·추적기가 없어요. 개인정보 처리방침이 "웹사이트는 쿠키와 스크립트를 쓰지 않아요"라고 적고 있으니 JavaScript는 넣지 않아요. 움직임과 눌러 보는 데모는 전부 CSS예요.

## 올리기 (Cloudflare Workers 정적 자산)

최신 wrangler는 Pages 명령을 Workers로 넘기므로 Worker `lepons`로 올려요. `site/`를 통째로 복사하고 README와 `og.py`만 빼서 올려요. 파일이나 폴더를 더해도 이 명령은 그대로예요.

```sh
npx wrangler login            # 처음 한 번
rm -rf /tmp/site-out && mkdir -p /tmp/site-out && cp -r site/. /tmp/site-out/ && rm /tmp/site-out/README.md /tmp/site-out/og.py
npx wrangler deploy --name lepons --assets /tmp/site-out --compatibility-date 2026-10-30 --domain lepons.app
```

- `.html` 주소는 확장자 없는 주소로 넘겨져요. 스토어 양식에는 `https://lepons.app/privacy`, `https://lepons.app/support`를 넣어요.
- Android 링크(`releases/latest/download/Lepons-Android.apk`)는 GitHub 최신 릴리스에 이 이름의 파일이 있어야 열려요. 올린 뒤에 배포해요.

배포는 외부에 공개되는 작업이라 올리기 전에 꼭 승인을 받고 진행해요.

## 고칠 때

개인정보 처리방침 내용은 실제 동작(중계 서버 기록 항목, 알림 내용, 저장 위치)과 같아야 해요. 그 동작을 바꾸면 이 페이지와 시행일도 함께 고쳐요.

- **iPhone 상태**: `index.html`과 `en/index.html`의 내려받기 구역에 있는 주석 바로 아래 한 줄만 바꾸면 돼요. App Store 승인 전에는 "App Store에서 받기"라고 적지 않아요. Google Play 문구도 공개 출시 뒤에 고쳐요.
- **그림**: 첫 화면의 지도와 폰은 HTML 안의 SVG이고, 상태가 바뀌는 시간표는 `style.css`의 `t1w`, `t1a` 같은 keyframes예요. 움직임을 끄면 입력 대기, 작업 중, 끝남이 함께 보이는 멈춘 그림이 나와요.
- **공유 카드**: 링크를 붙여 넣으면 나오는 카드는 `og.png`(한국어)와 `og-en.png`(영어)예요. 헤드라인을 바꾸면 `python site/og.py`로 다시 만들어요.
- **글꼴**: `fonts/lepons-sans.woff2`는 Pretendard에서 사이트에 쓰는 글자만 추린 파일이에요(라이선스 `fonts/LICENSE.txt`). 새 글자를 쓰면 그 글자만 시스템 글꼴로 보이니, 문구를 많이 고쳤다면 다시 만들어요.

  ```sh
  pip install fonttools brotli
  python -m fontTools varLib.instancer cockpit/src/renderer/fonts/PretendardVariable.woff2 wght=400:800 -o /tmp/pret.ttf
  cat site/*.html site/en/index.html > /tmp/chars.txt
  python -m fontTools subset /tmp/pret.ttf --text-file=/tmp/chars.txt --unicodes=U+20-7E --flavor=woff2 --layout-features=kern,liga,calt,ccmp,locl,mark,mkmk,tnum --name-IDs=0,13,14 --output-file=site/fonts/lepons-sans.woff2
  ```
- **공개 문구**: 한국어 먼저, 쉬운 말로 써요. 경쟁 제품 이름과 전화번호는 넣지 않고, 사진은 데모 데이터로만 찍어요.
