# 예배 PPT 생성기 (Church PPT Generator)

주보(PDF)를 읽어 매주 예배 PowerPoint 와 관련 파일들을 자동으로 만들어 주는 Windows 데스크톱 앱입니다. (임마누엘 선교교회)

한 번의 "생성" 으로 `C:\church\onlineservice` 아래에 다음 **5가지**가 만들어집니다.

1. `YYYY-MMDD-Sunday.pptx` — 예배 PPT
2. `YYYY-MMDD-Sunday.osz` — OpenLP 서비스 파일
3. `예배-Notes.txt` — 온라인 예배 노트
4. `예배 성경구절.txt` — 성경 본문
5. `Slide-Images/` — 슬라이드 이미지 (00-Announce / 01-Titles / 02-Verse / 04-Ending)

## 동작 방식

- **주보 PDF** 를 불러오면 날짜·설교제목·성경본문·대표기도·광고 등을 자동 추출해 폼에 채웁니다. (추출은 참고용이며, 확인/수정 후 생성)
- **성경 본문** 은 앱에 연결된 성경 DB(`C:\church\Bible.text`)에서 한/영 대역으로 자동 삽입됩니다.
- **찬송가** 는 라이브러리(`C:\church\찬송가`)에서 번호로 선택해 악보 슬라이드가 삽입됩니다.
- **찬양과 경배 / 경배와 찬양** 은 다른 분이 보내준 PPT 파일을 업로드하면 해당 위치에 삽입됩니다.
- 실제 PPT 조립은 설치된 **Microsoft PowerPoint** 를 COM 자동화로 제어해 이뤄집니다 (서식·이미지 100% 보존).

## 준비물 (필수)

- **Windows + Microsoft PowerPoint 설치**
- 아래 자료 폴더를 `C:\church\` 아래에 복사 (USB 등으로 공유)
  - `C:\church\Bible.text\` (성경 DB: 개역개정, ESV …)
  - `C:\church\찬송가\` (`NNN - 제목.pptx` + 동명의 `.xml`)
  - `C:\church\경배와 찬양\` (CCM 악보 PPT)
- 예배 템플릿 `2026-Sunday-Template.pptx` (기본 경로는 Dropbox 템플릿 폴더 — 설정에서 변경 가능)

경로는 앱의 **⚙️ 설정** 에서 언제든 바꿀 수 있습니다.

## 설치 (다른 컴퓨터에서 사용)

[Releases](https://github.com/jongha1618/church_pt-generator/releases) 에서 `ChurchPPTGenerator-Setup-x.y.z.exe` 를 내려받아 실행하면 설치됩니다. (자료 폴더 `C:\church\` 는 별도로 복사)

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
| `MK_praise_worship2` | 찬양과 경배(2부) PPT 삽입 |
| `MK_announcement:repeat` | 주일 광고 (복제+채움) |
| `MK_opening_hymn` | 말씀 전 찬양 삽입 |
| `MK_special_praise2:repeat` | 성가대 가사 (복제+채움) |
| `MK_bible_verse:repeat` | 성경 절 (복제+채움) |
| `MK_closing_hymn2` | 말씀 후 찬양 삽입 |
| `MK_closing_praise` | 예배 후 경배와 찬양 삽입 |
| `MK_closing_announcement:repeat` | 예배 후 광고 |
| `NOTES_intro_export` / `MK_transparent_titles` / `MK_transparent_bible_verse` / `MK_closing_announcement` | 이미지 export 대상 |

## 라이선스 / 자료

앱 코드는 MIT. 성경 역본·찬송가·CCM 은 저작권 자료이므로 저장소/설치본에 포함하지 않으며, 교회 내부적으로만 공유해 사용하세요.
