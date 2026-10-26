# 예배 PPT 생성기 (Church PPT Generator)

주보(PDF)를 읽어 매주 예배 PowerPoint 와 관련 파일들을 자동으로 만들어 주는 Windows 데스크톱 앱입니다. (임마누엘 선교교회)

한 번의 "생성" 으로 `C:\church\onlineservice` 아래에 다음 **5가지**가 만들어집니다.

1. `YYYY-MMDD-Sunday.pptx` — 예배 PPT
2. `YYYY-MMDD-Sunday.osz` — OpenLP 서비스 파일
3. `예배-Notes.txt` — 온라인 예배 노트
4. `예배 성경구절.txt` — 성경 본문
5. `Slide-Images/` — 슬라이드 이미지 (00-Announce / 01-Titles / 02-Verse / 04-Ending)

## 동작 방식

**⚡ 주보로 바로 생성** 버튼 하나면 끝입니다. 주보 PDF 를 고르면 앱이

1. 날짜·예배명·설교제목/설교자·성경본문·대표기도·축도·봉사위원·성가대·광고를 추출하고,
2. 예배 순서에 적힌 **찬양 제목을 찬송가/경배와찬양 라이브러리에서 찾아** 1부·2부 자리에 넣고,
3. 성경 본문을 한/영 대역으로 조회해,
4. `C:\church\onlineservice\YYYY-MMDD-Sunday.pptx` 를 바로 만듭니다.

찾지 못한 곡은 화면에 목록으로 표시되므로 직접 추가한 뒤 다시 생성하면 됩니다.
모든 추출 결과는 폼에서 수정할 수 있고, **주보만 불러오기** 로 확인 후 생성할 수도 있습니다.

- **성경 본문** 은 앱에 연결된 성경 DB(`C:\church\Bible.text`)에서 한/영 대역으로 자동 삽입됩니다.
- **찬송가 / 경배와 찬양** 은 교회 공용 드라이브의 라이브러리에서 제목·번호로 자동 매칭됩니다.
  주보가 통일찬송가 번호를 쓴 경우(예: "찬 48장. 만유의 주재") 제목을 우선해 찾습니다.
- **사도신경** 은 매주 같은 파일을 삽입합니다 (설정에서 경로 변경 가능).
- 실제 PPT 조립은 설치된 **Microsoft PowerPoint** 를 COM 자동화로 제어해 이뤄집니다 (서식·이미지 100% 보존).

## 준비물 (필수)

- **Windows + Microsoft PowerPoint 설치**
- 성경 DB `C:\church\Bible.text\` (개역개정, ESV …)
- 찬양 라이브러리 — 교회 공용 Google Drive (`G:`) 의
  - `…\ppt\1새찬송가\` (`NNN - 제목.pptx`)
  - `…\ppt\2경배와찬양-악보\` (초성 폴더별 CCM 악보 PPT)
  - 폴더를 여러 개 쓰려면 설정에서 `;` 로 구분해 입력합니다.
- 예배 템플릿 `2026-Sunday-Template.pptx` (기본 경로는 Dropbox 템플릿 폴더 — 설정에서 변경 가능)

경로는 앱의 **⚙️ 설정** 에서 언제든 바꿀 수 있습니다.

## 설치 (다른 컴퓨터에서 사용)

[**최신 설치 파일 받기**](https://github.com/jongha1618/church_pt-generator/releases/latest) — `ChurchPPTGenerator-Setup-x.y.z.exe` 를 내려받아 실행하면 설치됩니다.

`main` 에 푸시될 때마다 이 링크의 설치 파일이 자동으로 갱신됩니다. (성경 DB `C:\church\Bible.text\` 와 찬양 라이브러리는 별도로 준비)

## 개발

```bash
npm install
npm start        # 앱 실행
npm run dist     # NSIS 설치파일(.exe) 빌드 → release/
```

## 폴더 구조

```
src/
  main/
    main.js            Electron 메인 + IPC
    preload.js         contextBridge API
    config.js          경로 설정 (userData/config.json)
    bulletinParser.js  주보 PDF → 필드 추출
    songLibrary.js     찬송가/경배와찬양 라이브러리 색인 + 제목 매칭
    bible.js           성경 DB 리더 (BOM 감지, 66권, 한/영 대역)
    osz.js             OpenLyrics / OSZ 작성기
    recipe.js          고정 예배 레시피(마커 기반) → job 생성
    generator.js       오케스트레이션(성경조회·txt·osz·엔진 실행)
    ppt/engine.ps1     PowerPoint COM 자동화 (토큰치환·슬라이드삽입·이미지export)
  renderer/            UI (index.html / renderer.js / styles.css)
.github/workflows/build.yml   Windows 설치파일 자동 빌드
```

## 템플릿 마커 규칙

템플릿 슬라이드의 **발표자 노트**에 넣은 마커로 작업 위치를 찾습니다 (회중에겐 안 보임).

| 마커 | 용도 |
|---|---|
| `NOTES_intro_announcement` | 예배 전 안내 (복제+채움) |
| `MK_ apostles_creed` | 사도신경 PPT 삽입 |
| `MK_praise_worship1` / `MK_praise_worship2` | 찬양과 경배 1부 / 2부 PPT 삽입 |
| `MK_announcement:no-repeat` | 주일 광고 첫 장 (♥ 알립니다) |
| `MK_announcement:repeat` | 주일 광고 나머지 (복제+채움) |
| `MK_opening_hymn` | 말씀 전 찬양 삽입 |
| `MK_special_praise2:repeat` | 성가대 가사 (복제+채움) |
| `MK_bible_verse:repeat` | 성경 절 (복제+채움 — 화면용·투명용 블록 모두) |
| `MK_closing_hymn1` / `MK_closing_hymn2` | 말씀 후 찬양 1부 / 2부 삽입 |
| `MK_closing_praise` | 예배 후 경배와 찬양 삽입 |
| `MK_closing_announcement:repeat` | 예배 후 광고 |
| `NOTES_intro_export` / `MK_transparent_titles` / `MK_transparent_bible_verse` / `MK_closing_announcement` | 이미지 export 대상 |

## 라이선스 / 자료

앱 코드는 MIT. 성경 역본·찬송가·CCM 은 저작권 자료이므로 저장소/설치본에 포함하지 않으며, 교회 내부적으로만 공유해 사용하세요.
