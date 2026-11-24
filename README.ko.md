# herdr-toris-neon

[English](README.md) · **한국어** · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [Français](README.fr.md)

AI 코딩 에이전트를 위한 데스크톱 앱이자 터미널인 [Herdr](https://herdr.dev) 용 작업 공간 팩입니다. 에이전트 팀이 앱을 기획하고, 만들고, 테스트하고, 출시하는 모습을 Herdr 안에서 지켜볼 수 있습니다. 픽셀 팀 보드가 있는 앱 파이프라인, 에이전트가 직접 다루는 진짜 브라우저, 풀 리퀘스트, 기기 목록, 사용량, 네온 바이올렛 테마가 들어 있습니다.

![앱 파이프라인: 책상에 앉은 팀원들, 왼쪽은 팀 대화, 오른쪽은 고를 디자인 시안](docs/pipeline.png)

## 들어 있는 것

| 기능 | 여는 법 | 하는 일 |
| --- | --- | --- |
| **Auto app** | + 메뉴 → Auto app · `Ctrl/Cmd+Shift+Y` | 폴더와 아이디어를 주면 에이전트 팀이 리서치, 기획, 디자인, 개발, 기기 테스트, 스토어 자료 준비, fastlane 배포까지 진행합니다. |
| **오늘 · 이어하기** | + 메뉴 → 오늘 · 이어하기 · `Ctrl/Cmd+Shift+J` | 지금 이어갈 일을 보여 줍니다. 주요 작업 하나와 유지보수 하나, 프로젝트마다 다음 행동, 멈춘 이유, 이어갈 곳, 지난 검증이 아직 유효한지. 자세한 내용: [Today](docs/TODAY.md). |
| **Play 체크** | + 메뉴 → Play 체크 · `Ctrl/Cmd+Shift+L` | Google Play 개발자 계정의 모든 앱이 지금 어떤 상태인지 보여 줍니다. 트랙마다 출시됨, 검토 중, 반려됨, 초안, 테스트만. 읽기만 합니다. 자세한 내용: [Play check](docs/PLAY.md). |
| **Inspect 가 있는 브라우저** | `Ctrl/Cmd+Shift+U` | Herdr 안의 진짜 Chrome/Edge 입니다. 에이전트는 자기 탭을 다루고, 사람은 요소를 클릭해 바꿀 내용을 적어 에이전트에게 보냅니다. |
| **ALL agents** | `Ctrl/Cmd+Shift+A` | 실행 중인 모든 에이전트의 터미널을 한 화면에 봅니다. 다시 누르면 돌아옵니다. |
| **풀 리퀘스트** | `Ctrl/Cmd+Shift+G` | 터미널 옆에서 저장소의 PR 을 읽고, 댓글을 달고, 머지합니다. |
| **기기 목록** | `Ctrl/Cmd+Shift+D` | adb 기기(USB, Wi-Fi), Android 에뮬레이터, iOS 시뮬레이터를 이 컴퓨터와 연결된 컴퓨터에서 봅니다. |
| **파일, 편집기, 코드** | Files · `Ctrl/Cmd+Shift+H` | 파일 트리와 편집기, Markdown/HTML 미리보기, 코드 하이라이팅입니다. |
| **AI 사용량** | + 메뉴 → AI 사용량 | Claude 와 Codex 의 토큰, 예상 비용, 한도를 여러 컴퓨터에 걸쳐 봅니다. |
| **캡처 붙여넣기** | `Ctrl+V` · `Cmd+V` | 클립보드의 캡처가 Claude Code 나 Codex 에 이미지로 들어갑니다. 다른 컴퓨터의 터미널에도 됩니다. |
| **업데이트** | + 메뉴 → 업데이트 | GitHub 의 최신 버전을 받아 설치하고, 진행 상황을 화면에 보여 줍니다. |
| **봇** | Claude Code·Codex 에서 `@@이름` · 사이드바 | 목적과 기억을 가진 상주 에이전트입니다. `@@autoapp <아이디어>` 로 Auto app 실행을 시작합니다. 자세히: [Bots](docs/BOTS.md). |
| **에이전트 스킬** | Claude Code 와 Codex 에 설치됨 | `herdr-hc` 스킬이 `hc` 오케스트레이션, 창 조작, 브라우저 사용법을 에이전트에게 알려 줍니다. |
| **네온 바이올렛 테마** |  | 앱과 터미널 herdr 의 색, 그리고 어울리는 터미널 색 구성입니다. |

## Auto app: 아이디어에서 스토어까지

- + 메뉴에서 **Auto app** 을 열고, 프로젝트 폴더를 고르고, 무엇을 만들지 적습니다. 레퍼런스(플레이스토어 링크, 저장소, 스크린샷)가 있으면 함께 넣습니다.
- 팀원 아홉 명이 차례로 일합니다: 리서처, 기획자, 디자이너, 아티스트, 개발자, QA, 마케터, 릴리스 매니저, 퍼블리셔. 각자 새 에이전트로 시작해 작업 지시서 하나를 읽고 결과 하나를 쓰므로 대화가 쌓이지 않습니다.
- 모델마다 잘하는 일을 맡습니다. Grok 은 리서치, Codex 는 그림, Claude 는 기획·개발·배포입니다. 없거나 실패한 모델은 Claude 가 대신합니다.
- 시작 전에 팀을 구성합니다. 역할마다 이 컴퓨터에 설치된 에이전트 CLI, 모델, 동시에 일할 인원, 검토자를 고릅니다. 검토나 이미지 자동 검사에서 걸린 작업은 한 라운드 더 돌고, 실패한 테스트는 개발자에게 돌아갑니다.
- 얼마나 물어볼지 고릅니다: **무인**, **승격만 확인**(기본), **모두 확인**. 기획 후보와 디자인 시안은 카드로 떠서 눌러 고릅니다.
- 앱은 Flutter 로, 게임은 장르에 따라 Godot 또는 Unity + URP 로 만듭니다. 배포는 Play 내부 테스트 트랙을 거쳐 프로덕션으로 갑니다. 기존 Flutter·Godot·Unity 프로젝트 폴더를 고르면 그 엔진과 패키지 이름을 그대로 쓰고, 다른 스택(웹·Expo·네이티브 Gradle)은 이유와 함께 거절합니다.
- 레퍼런스는 참고만 하고 베끼지 않습니다. 장르와 핵심 루프는 가져오고, 이름·그림·문구는 새로 만듭니다.
- 선택 사항: **Replica 스킬 사용**(또는 `--replica`)을 켜면 [The Replica skill](https://github.com/Jakeschincariol/replica-skill) 의 11개 스킬이 단계 안에서 쓰입니다. 참고 앱의 분석 지도와 기능표를 만들고, 기획 전에 실제 리뷰를 읽고, 업로드 전에 지휘자가 기능 충족·참고 앱 잔여물·스토어 문구를 직접 검사합니다. Python 3.8 이상이 필요합니다. 스킬 묶음은 고정된 커밋으로 들어 있고(MIT), 켜지 않은 실행은 전과 같습니다.

자세한 내용: [앱 파이프라인](docs/PIPELINE.md).

## 브라우저: 보고, 가리키고, 고치게 하기

![브라우저 창: 실시간으로 그려지는 페이지, 주소줄, 실행 중인 에이전트가 보이는 Inspect 패널](docs/browser-chrome.png)

- macOS·Linux 에 그래픽 런타임이 있으면 herdr-web-browser 를 쓰고, 그 밖의 경우와 Windows 에서는 설치된 Chrome 이나 Edge 를 별도 프로필로 다룹니다.
- 에이전트는 `nv-web` 을 씁니다: `open`, `snapshot`, `click`, `type`, `inspect`, `console --errors`, `network --failed`, 그리고 고칠 스타일을 먼저 적용해 보는 `css`.
- **Inspect** 는 클릭한 요소(선택자, 스타일, 개발 빌드의 소스 파일, 테두리를 표시한 스크린샷)를 고른 에이전트에게 보냅니다.

자세한 내용: [브라우저와 문서 미리보기](docs/BROWSER.md).

## 에이전트, 풀 리퀘스트, 기기

![ALL agents 보드](docs/agents.png)

![기기 목록](docs/devices.png)

## 설치

Herdr 데스크톱 앱(또는 터미널 herdr 0.9.5 이상), Node.js 22 이상, Git 이 필요합니다. 파이프라인은 설치된 에이전트 CLI(`claude`, `codex`, `grok`)를 쓰고, 배포에는 fastlane 을 씁니다. 풀 리퀘스트에는 GitHub CLI(`gh`)가 필요합니다.

**macOS / Linux**

```bash
git clone https://github.com/torisKR/herdr-toris-neon.git
cd herdr-toris-neon
./install.sh
```

**Windows (PowerShell)**

```powershell
git clone https://github.com/torisKR/herdr-toris-neon.git
cd herdr-toris-neon
.\install.ps1
```

설치 스크립트는 herdr 설정과 단축키를 바꾸기 전에 백업하고, 테마·레이아웃·모드·단축키를 설치합니다. 직접 바꾼 단축키는 건드리지 않습니다. 그 뒤로는 + 메뉴의 **업데이트** 로 최신 상태를 유지합니다.

## 터미널 herdr 플러그인

같은 팩을 터미널 herdr 에서도 씁니다: `prefix a` ALL agents, `prefix d` 기기 목록, `prefix u` 텍스트 브라우저, `prefix f` 파일과 풀 리퀘스트(`prefix` 는 `ctrl+b`). 원격 패널에서 글자를 끌면 내 컴퓨터의 클립보드에 복사됩니다.

```bash
herdr plugin install torisKR/herdr-toris-neon/plugin
```

## 확인한 환경

- Windows 11 의 Herdr 데스크톱 앱: 위 기능을 모두 앱에서 실행했습니다. 파이프라인은 대역 에이전트로 끝까지, 첫 단계는 macOS 에서 실제 에이전트로 돌렸습니다.
- macOS: 파이프라인 첫 단계, 캡처 붙여넣기(로컬과 Windows 터미널로), 설치 구성 요소를 실행했습니다. 파이프라인의 뒤 단계와 스토어 업로드는 아직 실제로 돌려 보지 않았습니다.

## 출처

색은 VS Code 의 Cyber Purple 77 테마 스크린샷에서 영감을 받아 herdr 의 색 토큰에 맞게 새로 골랐습니다. macOS/Linux 의 그래픽 브라우저는 [herdr-web-browser](https://github.com/MattJColes/herdr-web-browser)(MIT)입니다.

## 라이선스

MIT
