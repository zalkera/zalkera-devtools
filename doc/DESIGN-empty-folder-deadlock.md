# 설계 메모 — 빈 폴더에 연결한 뒤 어느 단추도 앞으로 못 가는 교착

> 오너 신고(그대로): 「devtools vsix 에서 사이트 전환으로 빈 폴더 하나 지정했는데, 그리고 나서 서버 판으로
> 교체하려면 『받을 폴더가 비어 있지 않습니다. 빈 폴더를 고르거나, 기존 폴더는 「잘커라: 사이트에 연결」로
> 이어 주세요』 오류가 나고, zip 으로 교체하려면 먼저 다운로드 받으라고 하는데 안 되고 교착상태야.」

**상태: 구현 완료 · 미발행(0.31.1).** 설계 = Fable · 검토 = Opus(조건부 채택 → §10 이행) · 구현 = Opus.
기준 판 = `origin/main` `2581a50`(발행판 0.31.0). ⚠ 아래 §0~§9 는 **설계 당시 문서**다(수치·범위 포함). **구현이
설계와 달라진 자리는 §10·§11 이 정본**이다(특히 옛 표식은 «남지 않는다» · 되감기 안쪽은 `.zalkera` 하나).

---

## 0. 결론 요약

| 항목 | 판정 |
|---|---|
| 원인 | **우리 도구가 쓴 소속 표식 `.zalkera/source.json` 하나가 「비어 있지 않음」이 된다.** 받기·zip 풀기는 그 판정으로 거절하고, 교체 둘은 `package.json` 이 없어 열리지 않는다 — 앞으로 가는 단추가 0 이다 |
| 종류 | 0.1.12(`0bdaff0`)가 `.vscode` 로 겪은 **같은 자물쇠**다 — 「도구가 만든 파일 때문에 도구가 막힌다」. 그때 `.vscode` 만 무시 목록에 넣고 우리 표식은 안 넣었다 |
| 고치는 자리 | **「비어 있음」의 정의**(`emptyDir.ts`) — 우리 자기 상태 파일(표식·CLI 장부)뿐인 `.zalkera` 를 `.vscode` 와 같은 자리에서 무시한다. 받기 문의 거절 원칙은 그대로다 |
| 따라오는 것 | ⑴ 되감기 기준선을 통과 폴더 **안쪽까지** 잡는다(안 하면 실패 한 번으로 교착이 되살아난다 — 사본 실측) ⑵ 거절 문면이 **무엇이 있는지**와 다음 동사 **둘**을 말한다 ⑶ 직접 고르기의 연결 동의창이 빈 폴더에서 **다음 단추**를 말한다 |
| 유지하는 결정 | 받기는 비어 있지 않은 폴더를 거절 · 파괴 동사는 파괴 묶음에 · 소속을 바꾸는 동사는 「사이트에 연결」 하나(0.31.0 의 「빈 폴더에 받으면 소속이 바뀐다 — 먼저 말한다」 예외 포함) · 사이트 전환 화면에 파괴 선택지 없음 |
| 넓히는 결정 | 0.31.0 의 「이 폴더에 받기 — 소속이 바뀐다는 사실을 먼저」 갈래는 **링크만 있는 폴더**를 전제했는데, 현행 도구는 링크를 늘 표식과 짝으로 쓴다(`markFolderLinked`) — 그 갈래는 도구 자신의 산출물에 대해 **죽은 갈래**였다. 이 판이 그 갈래를 표식+링크 폴더까지 넓혀 **살린다** (§3) |
| 사본 실측 | core 시험 1,029/1,029 · 전 워크스페이스 typecheck 0 · 배선·소독·배송문면·인용·KDoc 검사기 초록 · 변이 5종이 전부 새 그물에 걸림 (§6.4) |
| 판 등급 | **patch** 이상(문면 셋·판정 하나·새 명령 0). 서버 영향 0 |

---

## 1. 교착 재현 — 코드 추적

### 1.1 「사이트 전환에서 빈 폴더를 지정」이 폴더에 쓰는 것

오너가 지난 길은 사이트 전환 화면의 **「로컬본 폴더 직접 고르기…」** 다(빈 폴더를 「지정」하는 항목은 이것뿐이다 — 「소스 다운로드」는 폴더를 고르면 바로 받고, 그 길은 빈 폴더에서 성공한다).

1. `chooseSite`(`extension.ts:3993`) → `decideSiteChoice`(`siteBinding.ts:157`) → `no-folder` 또는 `elsewhere` → `offerSiteFolder`(`extension.ts:4078`) → 항목 `pick-folder` → `openPickedLocalFolder`(`extension.ts:4328`).
2. 빈 폴더 F 를 고르면 `decidePickedFolder(null, {kind:"absent"}, X)`(`siteBinding.ts:333`) = **`link-consent`**.
3. 동의창(`say.pickedFolderLinkConfirm` · `tenantScope.ts:160`): 「고르신 폴더를 「X」 에 연결할까요?」 + `package.json` 이 없으면 `notSourceNote` 「이 폴더에서 package.json 을 찾지 못했습니다 — 사이트 소스 폴더가 맞는지 확인해 주세요.」 — **막지 않는다.** 단추 「연결하고 열기」.
4. 동의하면 `markFolderLinked(dir, X)`(`extension.ts:4392` → `:2599`) → `writeBindingMarkTo`(`localMark.ts:272`) → `ensureOwnDir(root, ".zalkera")` + `.zalkera/source.json` 에 `LinkedMark` 를 쓴다. 이어 `linkFolderToTenant`(`extension.ts:4395` → `localMark.ts:304`) → `.vscode/settings.json` 에 `zalkera.tenant`. `rememberFolder` → `openSiteFolder` → 같은 창에 F 가 열린다.

결과 상태 **S\***: F = `{.vscode/settings.json, .zalkera/source.json}` · `package.json` 없음 · 표식 `linked(X)` · 링크 X · 창의 사이트 X.

### 1.2 S\* 에서 각 명령이 하는 일 (판정 자리 · 문면)

| 명령 | 게이트(`whyBlocked.ts:75`) | 그 뒤 | 사람이 보는 문장 | 문장이 가리키는 다음 행동이 되는가 |
|---|---|---|---|---|
| 서버 판으로 교체 | `site` 요건 · `siteDir()`(`extension.ts:4559`)은 `package.json` 이 있어야 참 → **막힘** | — | 「이 창에 사이트 소스가 없습니다. 「내려받기」에서 소스를 먼저 받아 주세요 — …」 [소스 다운로드] (`whyBlocked.ts:148`) | 아니오 — 그 단추가 아래 행으로 간다 |
| zip 으로 교체 | 같음 | — | 같음 | 아니오 |
| 소스 다운로드 | 통과 | `chooseFetchTarget`(`extension.ts:1325`) → `isReceivable(F)` = **false**(`.zalkera` 가 `meaningfulEntries` 에 남는다 · `emptyDir.ts:24-35`) → `decideFetchTargetPlan` = `pick-only`(`siteBinding.ts:396`) → OS 대화상자 「…받을 새 빈 폴더를 고르세요 — 지금 폴더는 그대로 둡니다」 | F 를 고르면 `fetchSiteSource`(`fetchSource.ts:176-185`)가 **네트워크 전에** 던진다: 「받을 폴더가 비어 있지 않습니다.」 힌트 「빈 폴더를 고르거나, 기존 폴더는 「잘커라: 사이트에 연결」로 이어 주세요.」 | 아니오 — F 는 **이미 연결돼 있다**. 힌트대로 「사이트에 연결」을 누르면 아래 행 |
| zip 으로 시작 | 통과(`signedIn` 만) | `chooseImportTarget`(`extension.ts:1776`) → 같은 판정 → `pick-only` → F 를 고르면 `importZipInto`(`extension.ts:2035`) 「고르신 폴더가 비어 있지 않습니다. 빈 폴더를 골라 주세요」 | 같은 벽 | 아니오 |
| 소스 zip 다운로드 | 통과 | zip 파일 하나를 저장한다(`extension.ts:1714`) — 폴더에는 아무것도 안 한다 | 「…「zip 으로 시작」·「zip 으로 교체」에 바로 쓰실 수 있습니다」 | 아니오 — 그 둘이 위 두 행이다 |
| 사이트에 연결 | 통과 | `linkFolder`(`extension.ts:2610`): `binding` = X = 고른 X → 동의 없음 → 링크 다시 쓰기 · 표식은 그대로(`:2647` 조건) | 「이 폴더를 X 사이트에 연결했습니다.」 | 아무것도 안 바뀐다 |
| 사이트 전환(같은 X) | 통과 | `decideSiteChoice` = `unchanged` | 「이미 「X」 로 작업 중입니다.」 | 아무것도 안 바뀐다 |
| 사이트 전환(다른 Y) | 통과 | `elsewhere` → 선택지 화면 — 다른 자리로 갈 수는 있으나 F 는 그대로 남는다 | — | F 는 못 고친다 |
| 미리보기·배포·검사 | `site` → 막힘 | — | 위와 같은 문장 [소스 다운로드] | 아니오 |

**출구는 둘뿐이다** — ⑴ 숨은 폴더 `.zalkera` 를 손으로 지운다(문면이 그 이름을 말하지 않으므로 사람은 무엇을 지울지 모른다 · `help.md:695-696` 도 「빈 폴더를 새로 만들어」로만 안내) ⑵ 대화상자에서 **다른** 새 폴더를 고른다(그러면 F 는 소속 표식만 든 빈 폴더로 디스크에 남아, 다시 열면 같은 교착이다).

### 1.3 상태 조합 표 — 폴더 내용 × 표식 × 소속 × 명령

`R` = `isReceivable`(빈 폴더 판정) · `S` = `siteDir()`(`package.json`) · 소속 = `folderBinding`(표식 > 링크). 「현행」은 2581a50, 「목표」는 §2.

| # | 폴더 내용 | 표식 | 링크 | R | S | 소스 다운로드 / zip 으로 시작 | 교체 둘 | 현행 판정 | 목표 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 완전 빔 | 없음 | 없음 | ○ | × | `here` 로 이 폴더에 받는다 | 막힘 → [소스 다운로드] | 앞으로 감 | 같음 |
| 2 | `.vscode` 만 | 없음 | X 또는 없음 | ○ | × | `here` · 링크가 다른 사이트면 「바뀝니다」 먼저(0.31.0) | 막힘 → [소스 다운로드] | 앞으로 감 | 같음 |
| **3** | `.vscode` + `.zalkera/source.json` | **linked(X)** | X | **×** | × | `pick-only` → 같은 폴더 고르면 「비어 있지 않습니다」 | 막힘 → [소스 다운로드] → 위 | **교착** (오너 신고 · `openPickedLocalFolder` 와 `linkFolder` 가 만든다) | **R=○ → `here`** |
| **4** | 위 + 표식이 다른 사이트 Y | linked(Y) | Y | × | × | 같음 | 같음 | **교착** | R=○ → `here` + 「「Y」 에서 「X」 로 바뀝니다」 먼저 |
| **5** | 받은 폴더를 손으로 비움(`rm -rf F/*` 는 dot 항목을 못 지운다 — `extension.ts:2109` 가 그 함정을 적어 뒀다) | fetched(X, N) | X | × | × | 같음 | 같음 | **교착** | R=○(우리 파일뿐일 때) → `here` |
| 6 | `.zalkera/sync.json`(CLI 장부)만 | 없음 | — | × | × | 같음 | 같음 | 교착(CLI 사용자) | R=○ · 받기 성공 시 장부 삭제 |
| 7 | `.zalkera` 에 `pack.json`·`provenance.json` 등 | — | — | × | × | 거절 | 막힘 | 막힘(옳다 — 사람이 푼 흔적) | 같음 · 문면이 이름을 말한다 |
| 8 | 소스 있음(`package.json`) | 아무거나 | — | × | ○ | `sibling`(옆 폴더 제안) | **열린다** | 앞으로 감 | 같음 |
| 9 | 소스 아닌 사람 파일(README 등) | — | — | × | × | 거절 | 막힘 → [소스 다운로드] → 다른 폴더 | 앞으로 감(다른 폴더로) | 같음 · 문면이 이름·동사 둘을 말한다 |

교착 행은 3·4·5·6 — 전부 「`.zalkera` 아래 **우리 파일뿐**」인 폴더다. 목표는 그 넷을 행 1·2 와 같은 판정으로 접는 것이다.

### 1.4 실측 — 사본에서 core 를 직접 불렀다(네트워크 0)

명령(이 폴더에서): `node --experimental-strip-types repro.ts` — `repro.ts` 는 메인 체크아웃 `2581a50` 의 core 를 **읽기만** 하고 `os.tmpdir()` 아래에만 쓴다. 고친 판(`emptyDir.proto.ts` 적용 뒤)에서 돌리면 ④ 가 `[] · true`, ⑤ 가 `here`, ⑩ 의 `.zalkera` 가 `['source.json']` 로 바뀐다(사본 실측).

핵심 출력(발췌):

```
② decidePickedFolder(빈 폴더, alpha) = { kind: 'link-consent' }
③ 폴더 내용: [ '.vscode', '.zalkera' ] / .zalkera: [ 'source.json' ]   표식: {format:2, origin:'linked', tenant:'alpha'}
④ meaningfulEntries = [ '.zalkera' ] · isReceivable = false
⑤ decideFetchTargetPlan = { kind: 'pick-only' }
⑥ decideBlocked(zalkera.site.updateFromServer) = "이 창에 사이트 소스가 없습니다. 「내려받기」에서 …" [소스 다운로드]
   decideBlocked(zalkera.site.updateZip) = 같음 · site.open / importZip / downloadZip / site.link = null(통과)
⑦ fetchSiteSource 거절: 받을 폴더가 비어 있지 않습니다. | 빈 폴더를 고르거나, 기존 폴더는 「잘커라: 사이트에 연결」로 이어 주세요. | api 호출 수 = 0
⑧ decideSiteChoice(같은 사이트 다시) = unchanged · decideTenantScope = workspace · needsRelinkConsent = false
⑨ 링크만 있는 폴더(구판 형상): isReceivable = true · plan = here     ← 0.31.0 갈래는 이 형상만 산다
⑩ .zalkera 를 통과시키면: 되감기 뒤 .zalkera: [ 'provenance.json', 'source.json' ]  ← 기준선이 한 층이라 안쪽을 못 되감는다
```

### 1.5 같은 자물쇠의 다른 입구

- **사이드바 「사이트에 연결」**(`linkFolder` · `extension.ts:2610`): `package.json` 검사도 `notSourceNote` 도 없다. 빈 폴더를 열고 누르면 동의 없이(`binding` null) 링크+표식을 쓴다(`:2640-2649`) → 행 3.
- **손으로 비운 받은 폴더**(행 5): `.zalkera/source.json`(fetched) 이 남는다.
- **CLI `pull` 뒤 비운 폴더**(행 6): `.zalkera/sync.json`(`syncLedger.ts:26`).

### 1.6 0.31.0 의 「이 폴더에 받기 — 바뀐다는 사실을 먼저」는 도구 산출물에 대해 죽은 갈래였다

- `say.fetchTargetIntoOpen`(`tenantScope.ts:195-198`) KDoc: 「「비었다」의 잣대가 `.vscode` 를 무시하므로 **링크만 적어 둔 폴더**가 여기 온다」.
- 그런데 링크를 쓰는 두 자리(`openPickedLocalFolder`·`linkFolder`)는 `markFolderLinked` 와 **짝으로** 쓴다(`extension.ts:2590-2595` 「링크 쓰기와 짝으로만 부른다」). 표식이 서면 `.zalkera` 가 생기고 `here` 로 못 온다.
- 즉 그 갈래에 도달하는 폴더는 **구판(0.1.10 부근)이 사이트 선택 때 워크스페이스 설정을 쓰던 시절의 재고**뿐이다(`DEFERRED.md` 「구판이 남긴 밀린 링크」). `check-wiring.mjs:763-768` 의 주석(「링크만 가진 남의 폴더가 실제로 여기까지 온다」)도 같은 전제 위에 있다.

---

## 2. 목표 형상

### 2.1 원칙 — 「비어 있음」의 정의를 고친다. 받기의 거절은 그대로 둔다

- 0.1.12 의 규칙을 그대로 잇는다: 「무시하는 것은 **소스가 아닌 것**뿐 — 편집기 설정 · OS 부스러기」(`emptyDir.ts:12-15`). **우리 자기 상태 파일**도 소스가 아니다. 정본에 안 실리고(`zip.ts:388` `EXCLUDED_PATHS`), 받기가 성공하면 새 판으로 **다시 쓰이는** 파일이다(`writeSourceMark` · `extension.ts:1454`).
- 무시 대상 = `.zalkera` 가 **실제 폴더**이고 그 안이 **우리 파일뿐**일 때(표식 `source.json` · CLI 장부 `sync.json` · 원자 쓰기 잔재 `*.zalkera-<hex>.tmp`). 빈 `.zalkera` 도 우리 것이다.
- **`.zalkera` 를 통째로 무시하지 않는다** — 배송되는 `pack.json`·`ASSETS-LICENSE.md`(`zip.ts:396-399` · `localMark.ts:12-14`), 손으로 푼 zip 이 남기는 `provenance.json`, `saved/` 하위 폴더는 사람의 것이다. 하나라도 있으면 폴더 전체가 「비어 있지 않음」이다.
- 심링크는 어떤 이름이든 무시하지 않는다(기존 규율 · `emptyDir.ts:20-22`).

### 2.2 S\* 에서의 흐름 — 어느 단추를 눌러도 다음 단추가 있다

| 누른 것 | 보이는 것 | 다음 단추 | 결과 |
|---|---|---|---|
| 서버 판으로 교체 / zip 으로 교체 / 미리보기 | 「이 창에 사이트 소스가 없습니다. 「내려받기」에서 소스를 먼저 받아 주세요 …」 | [소스 다운로드] | 아래 행 |
| 소스 다운로드 | `isReceivable(F)` = ○ → `here` → 「지금 열어 두신 F 에 「X」 버전 N 을 풉니다.」(표식이 다른 사이트 Y 면 「받으면 이 폴더가 「Y」 에서 「X」 로 바뀝니다. …」 — 0.31.0 문면 그대로) | [이 폴더에 받기] | `fetchSiteSource` 통과 → 풀림 → `writeSourceMark` 가 표식을 `fetched(X, N)` 으로 덮어씀 → `linkFolderToSite` → 사이드바 갱신 → 「받았습니다」. **교체 둘·미리보기·배포가 열린다** |
| zip 으로 시작 | `here` → 「지금 열어 두신 F 에 이 zip 을 풉니다.」 | [이 폴더에 풀기] | `importZipInto` 통과 → `decideImportBinding(linked X, X)` = `bind` → 붙임 |
| 사이트에 연결 | 「연결했습니다」(변화 없음 — 막다른 길은 아니다) | — | — |
| 사이트 전환 → 직접 고르기 → 빈 폴더 | 동의창에 새 줄: 「이 폴더는 비어 있습니다 — 연결한 뒤 「소스 다운로드」를 누르시면 이 폴더에 받습니다.」 | [연결하고 열기] | 새 창에서 위 「소스 다운로드」 행 |

「한 번의 분명한 동작」 = **소스 다운로드 → [이 폴더에 받기]**. 잘못된 단추(교체)를 먼저 눌러도 그 단추가 이 동작으로 데려간다.

### 2.3 교착 조합 0 의 근거

- 행 3·4·5·6 이 R=○ 가 되어 행 1·2 와 같은 판정을 탄다(§1.3).
- 행 7·9(사람의 파일이 있는 폴더)는 **막는 것이 옳고**, 문면이 「무엇이 있는지」와 「다음 동사 둘」을 말한다(§6.2) — 「빈 폴더를 새로」·「사이트에 연결」·「서버 판으로 교체」 셋 다 실재하는 단추다.
- 실패 되감기 뒤에도 R=○ 가 유지된다(§6.1 두 층 기준선 · 시험 「표식뿐인 폴더에서 해제가 실패하면 «표식만» 남는다」).
- **경로 밖 상태(교체 중 즉사 잔재 `.zalkera-stash-*`)** 는 이 판의 범위 밖이고 종전과 같다(활성화 알림이 받는다).

---

## 3. 기존 결정과의 관계

| 결정(출처) | 이 판에서 |
|---|---|
| 받기는 비어 있지 않은 폴더를 거절 · 「덮을까요?」 완화 기각(`DESIGN-server-replace.md` §3) | **유지.** 거절 조건은 한 글자도 안 바뀐다. 바뀌는 것은 「비어 있음」의 정의이고, 그 정의는 0.1.12 가 이미 「도구가 만든 파일은 소스가 아니다」로 세워 둔 것이다. `.vscode` 를 무시한 근거가 우리 표식에도 그대로 선다 |
| 파괴 동사는 파괴 묶음에 · 교체 둘은 `site` 요건(`whyBlocked.ts:91-94`) | **유지.** 교체를 소스 없는 폴더에 열지 않는다(§4 기각 B) |
| 소속을 바꾸는 동사는 「사이트에 연결」 하나(`siteBinding.ts:325-327`) · 단 「빈 폴더에 받기」는 소속을 바꾸되 **먼저 말한다**(0.31.0 · `fetchTargetIntoOpen`) | **예외의 범위를 넓힌다.** 종전 예외는 「링크만 있는 빈 폴더」였고 현행 도구는 그런 폴더를 만들지 않는다(§1.6). 「표식+링크만 있는 빈 폴더」까지 같은 예외로 본다 — 바뀌는 것은 **비어 있는** 폴더의 소속뿐이라 올라갈 소스가 없고, 0.31.0 문면(「「Y」 에서 「X」 로 바뀝니다」)이 그대로 먼저 말한다. **왜 바꾸나**: 안 바꾸면 그 예외는 영원히 도달 불가이고, 도구가 자기 산출물에 대해 교착을 만든다 |
| 사이트 전환 화면에 파괴 선택지 기각(`DESIGN-elsewhere-drift.md` §0) | **유지.** 그 화면에 항목을 더하지 않는다 |
| 입양에 사전 확인 기각(`DECISIONS.md` 「사이트를 고른 뒤의 흐름」) | **유지** |
| 「모르는 것으로는 막지 않는다」 | **유지** — `.zalkera` 를 못 읽으면 「우리 파일뿐」이 아니라 「모른다」로 보고 **빈 것으로 치지 않는다**(막는 쪽으로 강하). 받기 거절은 되돌릴 수 있고 문면이 이름을 말하므로 이쪽이 안전하다 |

---

## 4. 기각한 대안

| 안 | 기각 사유 |
|---|---|
| **A. 「서버 판으로 교체」를 소스 없는 폴더에도 연다**(`site` 요건 완화 또는 `siteDir()` 우회) | `siteDir()` 은 사이드바·게이트·상태바가 **같이 쓰는 단일 술어**다(`extension.ts:4552-4557` 「판정이 하나여야 한다」). 한 명령만 다른 기준을 쓰면 「화면은 소스 없음인데 파괴 동사는 열리는」 형상이 된다. 「소스 다운로드」·「zip 으로 시작」의 벽은 그대로 남아 반쪽 해법이다 |
| **B. 빈 폴더에 연결할 때 표식을 안 쓴다**(링크만 남겨 0.31.0 갈래에 태운다) | 「링크와 표식을 같이 쓴다 — 둘이 갈리면 어긋남은 사고다」 불변식(`extension.ts:2590-2595`) 위반. 이미 디스크에 있는 교착 폴더(오너 것 포함)와 행 5·6 을 못 고친다 |
| **C. 받기가 `.zalkera` 를 통째로 무시** | `pack.json`·`ASSETS-LICENSE.md`·`provenance.json` 은 사람의 것이다(`zip.ts:396-399` 가 같은 이유로 통째 배제를 막아 뒀다). 손으로 푼 소스 위에 받게 된다 |
| **D. 문면만 고친다**(「.zalkera 를 지우세요」) | 비개발자에게 숨은 폴더를 지우게 하는 안내다. 도구가 만든 것을 사람이 치우는 형상 — 0.1.12 가 기각한 그 자세 |
| **E. 받기 전에 우리 파일을 먼저 지우고 완전 빈 폴더로 만든 뒤 받는다** | 네트워크 **전에** 파괴가 선다(전송 중 창을 닫으면 표식이 사라진다). 두 층 기준선이 파괴 없이 같은 결과를 낸다 |
| **F. 사이트 전환 화면에 「이 빈 폴더에 받기」 항목** | 그 화면은 「어디서」를 고르는 자리이고 「소스 다운로드」 항목이 이미 그 일을 한다(폴더를 고르면 받는다). 항목 증식 |
| **G. 직접 고르기에서 빈 폴더를 고르면 곧장 받기**([받아서 열기] 단추) | 교착 해소에 필요 없다(§2.2 로 이미 0). `openSite` 의 뒷부분을 함수로 떼어 새 배선·핀을 만드는 일이라 이 판에 안 싣는다 — §7 2차 후보로 남긴다 |

---

## 5. 안전 불변식과 근거

| 불변식 | 근거 |
|---|---|
| **고치던 소스를 조용히 밀지 않는다** | 무시 대상은 우리가 쓰는 세 이름과 그 잔재뿐이고, `.zalkera` 안에 그 밖의 항목(파일·폴더·심링크)이 하나라도 있으면 통째로 「비어 있지 않음」이다. 시험 「.zalkera 안에 우리 것이 아닌 항목이 하나라도 있으면 막는다」(`pack.json`·`provenance.json`·`ASSETS-LICENSE.md`·임의 파일·하위 폴더 다섯 갈래) |
| **심링크로 폴더 밖에 쓰지 않는다** | `.zalkera` 가 심링크면 `isDirectory()` 가 거짓이라 통과 못 함 + 명시 심링크 검사(벨트) · 안쪽 항목이 심링크면 `ownStateOnly` 거짓. 시험 「.zalkera 가 심링크거나 그 안이 심링크면 무시하지 않는다」 |
| **실패하면 우리가 쓴 것만 되감고, 되감은 뒤 다시 받을 수 있다** | 기준선이 통과 폴더 안쪽까지(`Snapshot.inside`). 시험 「되감기는 통과시킨 폴더 «안쪽»에서 생긴 것만 지운다」 · 「표식뿐인 폴더에서 해제가 실패하면 «표식만» 남는다」(문 끝단). 변이 B(안쪽 되감기 제거)가 빨강 |
| **고객이 만든 `.vscode` 파일은 안 지운다** | 기존 시험 그대로(`fetchSource.test.ts:109` · `importExtract.test.ts:147`) — 안쪽 기준선은 **있던 것을 지키는** 방향으로만 작동한다 |
| **네트워크 먼저, 파괴는 나중** | 판정은 여전히 받기 전에(`fetchSource.ts:176`) · 되감기는 실패 뒤에 · 장부 삭제는 성공 뒤에. 전송 중 창을 닫아도 폴더는 그대로다 |
| **모르는 것으로 막지 않되, 모르는 것을 빈 것으로 치지도 않는다** | `.zalkera` 를 못 읽으면 `ownStateOnly` = 거짓 → 「비어 있지 않음」 → 거절 문면이 이름을 말한다. 거절은 되돌릴 수 있는 방향이다 |
| **표식 갱신은 부르는 쪽 몫 그대로** | `fetchSiteSource` 는 `source.json` 을 안 건드린다(성공 시 확장 `writeSourceMark` 가 `fetched` 로 덮는다 — 종전 경로). `sync.json` 만 성공 뒤 지운다(§6.2) |
| **문면 소독** | 거절 문면의 이름들은 `DevtoolsError.message` 로 가고 보여 주는 자리 `decideErrorNotice`(`errorNotice.ts:59`)가 `plainNotice` 를 지난다. 새 `say` 줄은 리터럴 |

---

## 6. 구현 지시

설계 당시 프로토타입은 설계 세션의 작업 폴더에 두었다(레포 밖). 구현은 §10 대로 했다.

### 6.1 `packages/core/src/emptyDir.ts` — 판정과 기준선

- 가져오기: `SOURCE_MARK_PATH`(`localMark.ts`) · `SYNC_LEDGER_PATH`(`syncLedger.ts`) · `isOwnTmp`(`zip.ts`). 순환 없음(셋 다 `emptyDir` 를 안 부른다 — 사본 typecheck 로 확인).
- 새 수출 `OWN_STATE_FILES: readonly string[] = [SOURCE_MARK_PATH, SYNC_LEDGER_PATH]` — **경로 상수를 그대로** 쓴다(손 목록 금지). 폴더 이름은 그 둘의 `dirname` 에서 구하고 둘이 다르면 모듈 로드에서 던진다(상수가 갈리는 날 조용히 안 지나가게).
- `ownStateOnly(dir)`: `readdir(withFileTypes)` → 모든 항목이 `isFile() && !isSymbolicLink() && (이름 ∈ OWN_STATE_NAMES || isOwnTmp(이름))`. 못 읽으면 **거짓**.
- `passable(dir, e)`: 심링크면 거짓 → `IGNORED` 면 참 → `e.name === ".zalkera" && e.isDirectory() && ownStateOnly` 면 참.
- `meaningfulEntries` 는 `passable` 이 아닌 이름만 돌려준다(계약 그대로 `string[]`).
- `snapshotEntries` 의 반환을 `Snapshot = {names: Set<string>; inside: Map<string, Set<string>>}` 로. `inside` 는 통과 대상 이름(`IGNORED` ∪ `.zalkera`) 중 **실제 폴더**인 것의 안쪽 이름. 못 읽으면 그 폴더는 `inside` 에 안 넣는다(안쪽을 되감지 않는다 — 모르는 것을 지우지 않는다).
- `removeAdded(dir, before)`: 종전 한 층 + `before.inside` 각 폴더 안에서 기준선에 없던 이름 삭제. 실패는 삼킨다(종전 규율).
- 부르는 쪽(`fetchSource.ts:202-216` · `extension.ts:2047-2052`)은 **바꾸지 않는다** — 값을 그대로 넘긴다. `index.ts:119` 수출에 `type Snapshot` 과 `OWN_STATE_FILES` 를 더한다.
- KDoc 에 2026-09-24 신고를 0.1.12 신고 아래 같은 형식으로 적는다(왜 `.zalkera` 통째가 아닌지 · 왜 안쪽 기준선인지).

### 6.2 `packages/core/src/fetchSource.ts` — 거절 문면 · 장부

- 거절(`:180-184`): 이름 앞 넷 + 「외 n개」(`droppedLine` 과 같은 규율).
  - message: `받을 폴더가 비어 있지 않습니다(있는 것: README.md · src 외 3개).`
  - hint: `빈 폴더를 고르세요. 그 폴더의 소스를 그대로 쓰시려면 「사이트에 연결」, 서버 판으로 바꾸시려면 그 폴더를 열고 「서버 판으로 교체」입니다.`
  - 종전 힌트가 「사이트에 연결」만 말해 서버 판을 원하던 사람을 연결로 보냈다 — 이번 신고의 둘째 고리다.
- 성공 뒤: `before.inside.get(".zalkera")` 에 `sync.json` 이 있었으면 지우고 `report("지난 CLI 장부(.zalkera/sync.json)는 이 판과 맞지 않아 지웠습니다.")`. 근거 — 장부 `files` 는 「판의 진실」로 쓰여 다음 `pull` 이 「이 폴더에서 고친 것이 N개」로 거절한다(`pull.ts:118-125` · `syncLedger.ts:10-13`). 「서버 판으로 교체」는 `.zalkera` 를 치우며 이미 지운다(`replaceContents` 의 `keep` 은 `isExcludedEntry(".zalkera")` 가 거짓이라 안 남긴다) — 같은 결과로 맞춘다. 양성 짝: 장부가 없던 폴더에서는 그 말을 안 한다.
- `refreshSiteSource`·`downloadSourceZip` 은 손대지 않는다.

### 6.3 확장·문면 — 직접 고르기 동의창의 빈 폴더 줄

- `tenantScope.ts:160-173` `pickedFolderLinkConfirm` 에 칸 하나: `emptyNote: "이 폴더는 비어 있습니다 — 연결한 뒤 「소스 다운로드」를 누르시면 이 폴더에 받습니다."` (리터럴 · 사이트 이름은 `message` 가 이미 든다 — 전수 스위프(`tenantScope.test.ts:57`)는 문자열 칸 중 **하나**에 이름이 있으면 통과).
- `extension.ts:4374-4388` `link-consent` 갈래: `const receivable = await isReceivable(dir)` 를 `looksLikeSource` 옆에 재고, `detail` = `receivable ? emptyNote : looksLikeSource ? "" : notSourceNote` 를 `ask.detail` 뒤에 붙인다. 빈 폴더는 `package.json` 이 없으므로 `notSourceNote` 보다 **앞에서** 갈라야 한다(안 그러면 「소스 폴더가 맞는지 확인하세요」가 빈 폴더에도 뜬다 — 지금 그렇다).
- `linkFolder`(`:2610`)는 손대지 않는다 — 그 문은 열린 폴더에 대한 명시 동사이고, 연결 뒤 사이드바 「소스 다운로드」가 §2.2 대로 받는다. (같은 줄을 완료 알림에 넣을지는 §7.)
- 배선 검사(`check-wiring.mjs`): `isReceivable(openDir)` 두 자리는 그대로. 새 `isReceivable(dir)` 호출은 핀을 안 세운다 — 없어져도 결과는 문면 한 줄이라 거짓이 아니다(있는 사실을 덜 말할 뿐).

### 6.4 시험 — 무엇을 재는 그물인지 · 변이 실측

사본에서 아래를 붙이고 돌렸다: core `node --test --experimental-strip-types "src/**/*.test.ts"` → **1,029/1,029**(신규 9). `tsc` core·vscode·cli 전부 0. `check-wiring`·`check-notice`·`check-shipped-claims`·`check-help-quotes`·`check-kdoc-attached` 초록.

`emptyDir.test.ts` 에 더하는 것(전문은 `emptyDir.test.append.ts`):

| 시험 | 재는 것 | 죽이는 변이(실측) |
|---|---|---|
| 우리 소속 표식뿐인 폴더는 빈 폴더다(+ 장부 · + 빈 `.zalkera`) | 교착 행 3·5·6 의 판정 | A(`.zalkera` 통과 제거 = 옛 판정) · E(목록을 손으로 적고 `sync.json` 누락) |
| `.zalkera` 안에 우리 것이 아닌 항목이 하나라도 있으면 막는다(5 갈래 + 하위 폴더) | 불변식 「고치던 소스를 밀지 않는다」의 새 경계 | C(`ownStateOnly` 늘 참) |
| `.zalkera` 심링크 · 안쪽 심링크 | 폴더 밖 쓰기 차단 | C |
| 되감기는 통과 폴더 안쪽에서 생긴 것만 지운다 · 되감은 뒤 R=○ | 실패 한 번으로 교착이 되살아나지 않음 | A · B(안쪽 되감기 제거) |
| 자기 상태 파일 목록은 zip 배제 목록과 같다(`isExcludedEntry` 로 대조) | 두 목록의 갈림 | 목록에 zip 이 싣는 이름을 넣으면 빨강 |

`fetchSource.test.ts` 에 더하는 것(`fetchSource.test.append.ts`):

| 시험 | 재는 것 |
|---|---|
| 표식뿐인 폴더에는 받는다 — `package.json`·`.zalkera/pack.json` 풀리고 `provenance.json` 은 빠지며 `source.json`·`.vscode` 는 남는다 | 문 끝단 성공 경로(행 3) |
| 표식뿐인 폴더에서 해제가 실패하면 표식만 남고 R=○ | 문 끝단 되감기 |
| 비어 있지 않으면 이름과 동사 둘을 말한다 · 네트워크 전에(api 호출 0) | 문면 · 순서 |
| 지난 CLI 장부가 든 폴더에 받으면 장부를 지우고 말한다 · 없던 폴더에서는 안 말한다(양성 짝) | 장부 처리 |

기존 그물이 그대로 무는 것: `emptyDir.test.ts` 「사람이 만든 파일이 하나라도 있으면 막는다」·「.git 은 무시하지 않는다」·「심링크」 · `fetchSource.test.ts:83-129` · `importExtract.test.ts:121-176`. 변이 D(`passable` 의 심링크 검사 제거)는 기존 시험 「무시 이름이라도 심링크면」이 잡는다 — `.zalkera` 심링크 시험은 `isDirectory()` 로도 막혀 D 에서 초록이다(벨트와 멜빵 · 기록해 둔다).

**확장 배선은 그물이 0벌**(이 레포의 알려진 한계 · `DEFERRED.md`). 6.3 은 문면 한 줄이라 거짓을 만들 자리가 없고, `chooseFetchTarget`·`chooseImportTarget` 은 한 줄도 안 바뀐다.

### 6.5 문서

| 파일 | 자리 | 고칠 것 |
|---|---|---|
| `packages/vscode/media/help.md` | `:34-35` | 「(편집기가 만든 `.vscode` 폴더는 있어도 괜찮습니다.)」 → 「편집기가 만든 `.vscode` 폴더와 저희가 남긴 표식(`.zalkera/source.json`)만 있는 폴더는 빈 폴더로 봅니다.」 |
| 같은 파일 | `:220-222` · `:439-440` · `:470-471` | 「빈 폴더를 열어 두셨다면」 — 「사이트에 연결만 해 둔 빈 폴더도 같습니다」 한 구 |
| 같은 파일 | `:695-696` | 「받을 폴더가 비어 있지 않습니다」 항목 — 오류가 **무엇이 있는지 이름을 말한다**는 것 · 다음 동사 둘 |
| `doc/MANUAL.md` | `:57-59` | 위 `:34-35` 와 같은 구 |
| 같은 파일 | `:565` | 「빈 폴더였는데도 막히면 앞서 받다가 중간에 멈춘 파일이 남은 것이니 폴더를 비우고」 → 「오류 문장이 무엇이 남았는지 말합니다. 저희 표식만 남은 폴더는 막히지 않습니다」 |
| 같은 파일 | `:563` | 「「소스 다운로드」는 빈 폴더만 받습니다」 그대로(참) |
| `doc/DECISIONS.md` | 「폴더와 사이트의 소속」 표 | 행 추가: 「빈 폴더 판정에서 `.zalkera` 통째 무시 — 기각(배송 파일)」 · 「빈 폴더에 연결할 때 표식 생략 — 기각(링크·표식 짝)」 · 「교체를 소스 없는 폴더에 열기 — 기각(`siteDir` 단일 술어)」 |
| `doc/DEFERRED.md` | 「폴더 없는 창의 「어느 폴더에서」 화면」 아래 | §7 의 2차 후보 셋을 「알고 있다」로 |
| `doc/DESIGN-elsewhere-drift.md` | §0 표 아래 한 줄 | 「직접 고르기로 빈 폴더를 고르면 표식이 서서 받기가 막히던 것은 `DESIGN-empty-folder-deadlock.md`」 참조 |
| `packages/vscode/CHANGELOG.md` | 새 판 머리 | 개조식 셋: 「사이트에 연결만 해 둔 빈 폴더에 「소스 다운로드」·「zip 으로 시작」이 받습니다 — 저희 표식 하나로 「비어 있지 않습니다」가 되어 어느 단추도 못 누르던 것」 · 「그 오류가 무엇이 있는지 이름을 말하고, 다음 할 일을 둘로 말합니다」 · 「「로컬본 폴더 직접 고르기」로 빈 폴더를 고르시면 연결 뒤 무엇을 누를지 말씀드립니다」 |
| `emptyDir.ts` KDoc · `fetchTargetIntoOpen` KDoc(`tenantScope.ts:195-198`) · `check-wiring.mjs:765` 주석 | — | 「링크만 적어 둔 폴더」 → 「링크·표식만 적어 둔 빈 폴더」 |

### 6.6 판 등급 · 검사기 영향

- 새 명령·사이드바 항목 0 · `say` 칸 하나 추가 · core 수출 둘 추가 → **patch**(0.31.1) 로 족하다. 오너 판단.
- `check-help-quotes` 는 `help.md` 의 「」 인용을 배송 문면과 대조한다 — 새 문장에 넣는 동사 이름(「사이트에 연결」·「서버 판으로 교체」·「소스 다운로드」)은 전부 실재 라벨이다.
- `check-shipped-claims` 폐기 주장 목록에 「빈 폴더를 새로 만들어」 류는 없다(사본 초록).

---

## 7. 2차 후보 (이 판에 안 싣는다 · 오너 판정)

1. **직접 고르기에서 빈 폴더를 고르면 [받아서 열기]** — `openSite` 의 「받을 자리 확정 뒤」 부분을 `fetchInto(pinned, target, openDir)` 로 떼어 두 자리가 쓰게 한다. 클릭 둘이 준다. 대가: 새 배선·핀, 「직접 고르기」가 받기도 하게 되어 한 동사 두 뜻.
2. **게이트 문면의 특수화** — 열린 폴더가 R=○ 이고 소속이 있으면 「이 폴더는 비어 있습니다 — 「소스 다운로드」로 여기에 받습니다」. `decideBlocked` 입력에 `receivable` 이 들어가야 하고 `announceIfBlocked` 가 명령마다 `readdir` 을 한 번 더 한다(제스처당 1회 · 작다).
3. **사이드바 「작업 폴더」 줄** — 같은 조건에 `info` 한 줄. `SidebarState` 칸 추가 → `check-sidebar-labels.mjs` 의 손 복제 `STATES` 드리프트(`DEFERRED.md` 기명)를 밟는다.
4. **`linkFolder` 완료 알림**에 빈 폴더면 같은 안내 한 구.

---

## 8. 확인 못 함

- 실물 VS Code 창에서의 왕복(vsix 를 굽고 눌러 보는 것) — 이 메모는 core 실측 + 확장 코드 추적이다. 특히 `showOpenDialog` 뒤 같은 폴더를 고르는 순간의 문면은 코드 추적이다.
- 오너가 실제로 지난 항목이 「로컬본 폴더 직접 고르기…」인지 사이드바 「사이트에 연결」인지 — 두 길 다 같은 S\* 를 만들고(§1.5) 같은 처방으로 풀린다.
- 백엔드 정본 tar 에 `.zalkera/pack.json`·`ASSETS-LICENSE.md` 가 실리는 정확한 조건(팩 소스에만인지) — 이 레포 밖. 실리든 안 실리든 판정은 같다(있으면 사람의 것).
- CLI `pull` 이 확장이 받은 폴더에서 어떻게 도는지의 상용 왕복 — 장부 삭제는 코드 추적으로 정한 것이다.

---

## 9. 재현 근거 목록

| 주장 | 근거 |
|---|---|
| 「비어 있음」 판정이 `.zalkera` 를 센다 | `packages/core/src/emptyDir.ts:24-35` · `grep -n "IGNORED" packages/core/src/emptyDir.ts` |
| 받기 거절 문면·네트워크 전 | `packages/core/src/fetchSource.ts:176-185` · repro ⑦ `api 호출 수 = 0` |
| zip 풀기도 같은 판정 | `packages/vscode/src/extension.ts:2032-2041` |
| 직접 고르기가 빈 폴더에 표식+링크를 쓴다 | `extension.ts:4374-4395` · `:2599-2608` · `localMark.ts:272-293, 304-332` · repro ②③ |
| 사이드바 「사이트에 연결」도 같다 | `extension.ts:2610-2660`(`package.json` 검사 없음 · `:2647` 표식 조건) |
| 교체 둘·미리보기·배포가 `site` 요건으로 막히고 [소스 다운로드] 로 보낸다 | `packages/core/src/whyBlocked.ts:75-116, 148-155` · `extension.ts:910-932` · repro ⑥ |
| `siteDir()` = `package.json` | `extension.ts:4559-4562` |
| 소스 다운로드가 `pick-only` 로 떨어진다 | `siteBinding.ts:396-400` · `extension.ts:1335-1341, 1401-1408` · repro ⑤ |
| 링크만 있는 폴더는 통과(0.31.0 갈래) · 표식+링크는 못 온다 | repro ⑨ vs ④ · `tenantScope.ts:195-198` · `extension.ts:2590-2595` |
| `.zalkera` 통과 시 한 층 되감기의 구멍 | repro ⑩ · `emptyDir.ts:49-74`(현행) |
| `.zalkera` 통째 배제 금지의 근거 | `packages/core/src/zip.ts:381-399` · `localMark.ts:8-14` |
| 장부 낡음의 해 | `packages/core/src/pull.ts:118-125` · `syncLedger.ts:2-13, 26` |
| 0.1.12 의 같은 종류 수정 | `git show 0bdaff0 --stat` · 커밋 본문 「도구가 만든 파일 때문에 도구가 막히는 자물쇠」 |
| 프로토타입 초록·변이 빨강 | 사본에서 `node --test --experimental-strip-types "src/**/*.test.ts"`(1,029) · 변이 A~E 출력(§6.4) — 명령·출력은 이 메모 작성 세션 기록 · 프로토타입 파일은 이 폴더 |
| 배송 문서의 현행 문장 | `packages/vscode/media/help.md:34-35, 199-222, 439-443, 470-471, 695-696` · `doc/MANUAL.md:57-59, 563, 565` |

---

## 10. 검토 반영 — 구현이 설계와 달라진 자리 (정본)

검토(Opus)가 조건부 채택으로 넘긴 🟠 넷과 🟡 일부를 이렇게 이행했다.

| 지적 | 구현 |
|---|---|
| 🟠 받기 뒤 **옛 표식이 이긴다** — 새 표식 쓰기가 실패하면 옛 판(거짓 409)·옛 소속(다른 사이트)이 남는다. 설계 시험은 오히려 「표식이 남는다」를 굳혔다 | core `clearStaleOwnState(dir, before, "fetched")` 가 받기 성공 뒤 **기준선에 있던** 옛 표식을 지운다. 새 표식은 확장이 받은 판으로 쓰고, 그 쓰기가 실패해도 「표식 없음 → 링크가 소속」으로 떨어진다. 시험은 «옛 표식이 남지 않는다»로 뒤집었다(연결 표식·받은 판 표식 두 갈래) |
| 🟠 **zip 을 푸는 길**에 판을 주장하는 옛 표식·옛 CLI 장부가 남는다 | 같은 함수를 `"imported"` 로 `importZipInto` 가 부른다. 판을 주장하는 표식(받기·발행)은 **같은 사이트의 연결 표식으로 낮춘다** — 지우면 소속이 조용히 바뀌기 때문이다(`DECISIONS.md`). 연결 표식·못 읽는 표식은 그대로 둔다. CLI 장부는 두 문 모두 지운다 |
| 🟠 새 거절 힌트가 **막다른 길**을 다시 만든다(소스 없는 폴더에 「서버 판으로 교체」를 권함) | 힌트를 형상으로 가른다 — `package.json` 이 있을 때만 「사이트에 연결」·「서버 판으로 교체」, 아니면 「빈 폴더를 새로 만들어 골라 주세요」. 시험이 `.git` 만 있는 폴더·사람 파일만 있는 폴더에서 두 동사가 **없음**을 문다(양성 짝 = 소스 폴더) |
| 🟠 상태표 누락 — 대화상자로 다른 빈 폴더를 고르는 길은 옛 소속을 말하지 않는다 · zip 길의 `keep` | 「먼저 말한다」의 범위를 `here` 갈래로 좁혀 적었다(`tenantScope.ts` `fetchTargetIntoOpen` KDoc). 대화상자 길은 빈 폴더라 잃는 것이 없고, 받은 뒤 표식은 받은 판으로 선다. zip 길은 종전 `decideImportBinding` 그대로(다른 사이트 소속이면 `keep`) · 판 주장만 낮춘다 |
| 🟡 `.zalkera` 안의 `.DS_Store` 하나로 다시 잠긴다 | `ownStateOnly` 가 OS 부스러기 **파일**을 받는다(폴더면 거절 — 양성 짝 시험) |
| 🟡 「zip 으로 교체」의 안내 단추가 [소스 다운로드] | 소스 없는 창에서는 [zip 으로 시작]이 첫 단추, [소스 다운로드]가 둘째(`whyBlocked.ts`) |
| 🟡 zip 거절 문면이 이름을 말하지 않는다 | 받기와 같은 조각(`occupiedLine`)을 쓴다 |
| 🟡 「자기 상태 목록 = zip 배제 목록」 시험 제목 | 「부분집합」으로 고쳤다 |
| 🟡 `findProjectRoot` 가 `.vscode`·`.zalkera` 도 폴더로 센다 | `DEFERRED.md` 에 적었다(정본 tar 가 한 겹 싸여 오는지 먼저 잰다) |

## 11. Fable 3축 심의 반영 (정본)

| 지적 | 구현 |
|---|---|
| 🟠 거절 문면이 「있는 것: .zalkera」까지만 말해 도움말(「`.zalkera` 만 있으면 빈 폴더」)과 부딪힌다 — 손으로 비운 팩 폴더에는 배송 파일이 남는다 | `meaningfulEntries` 가 통과 못 한 `.zalkera` 를 **걸린 안쪽 이름**(`.zalkera/pack.json` 등)으로 편다. 도움말·매뉴얼은 「연결 표시만 든 `.zalkera`」로 좁혔다 |
| 🟠 zip 을 연결만 해 둔 폴더에 풀면 완료 문장이 할 일 없는 「사이트에 연결」을 권하고, 다른 사이트에 연결된 폴더면 그 사실을 안 말한다 | 풀기 전 「이 폴더에 풀기」 문장이 폴더에 적힌 소속을 말한다(풀어도 그대로) · 완료 문장은 폴더의 소속으로 가른다(연결돼 있으면 「그 사이트로 미리보기·올리기가 됩니다」, 고르신 사이트와 다르면 바꾸는 동사를 덧붙임) |
| 🟠 되감기 안쪽 루프가 기준선 뒤 심링크로 바뀐 `.zalkera` 를 따라가 폴더 밖을 지운다 | 기준선에 그 폴더의 신원(장치·inode)을 적고, 내려가기 직전 같은 실제 폴더일 때만 내려간다. 잰 뒤와 지우기 사이 잔여 창은 KDoc 에 적었다(Node 에 `unlinkat` 없음) |
| 🟡 `.vscode` 안쪽 기준선은 이득 없이 사람 파일을 지운다 | 안쪽 기준선을 `.zalkera` 하나로 좁혔다 |
| 🟡 긴 이름 하나가 알림 상한을 먹어 다음 할 일이 잘린다 | `occupiedLine` 이 이름마다 40자로 자른다 |
| 🟡 낮추기 로그가 장부에도 「판 번호 주장을 뺐습니다」 | 「정리했습니다」로 낮췄다 |
| 🟡 동의창이 소스 폴더에서도 빈 폴더 판정을 잰다 | 소스 폴더면 재지 않는다 |
| 🟡 KDoc 「`zip.ts` 가 같은 상수를 쓴다」 | 사실대로(부분집합을 시험이 문다) |
