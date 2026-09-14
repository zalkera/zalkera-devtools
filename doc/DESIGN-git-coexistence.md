# 설계 메모 — git · GitHub 와 함께 쓰기: 확장은 git 을 모른 채로 맞물린다

> 오너 문제 제기: 소스의 버전 관리를 GitHub 로 하려면, 확장에 GitHub 연동을 넣는 대신
> VS Code 기본 Git(`vscode.git`) + GitHub Authentication + GitHub Pull Requests 확장에 맡기는
> 방향으로 간다. 그 위에서 잘커라 확장과 **끊김 없이** 돌게 할 수 있는가.

**상태: 구현 완료 · 미발행.** 오너 결정(2026-09-14): §8 의 ①·② **예** · ③ **아니오**. T0(문서)·T1·T1'·T2·T3
전부 한 판에 실린다. 설계·구현 = Opus · 3축 심의 = §10.

---

## 0. 결론 요약

**정책 한 줄**: 확장은 **GitHub 에 접속하지 않고, 커밋·푸시를 만들지 않고, 사람이 누르지 않은 git 명령을
돌리지 않는다**(`vscode.git` 을 통해 상태를 읽고, 누른 뒤에만 태그 하나를 만든다). git 이 있는 폴더에서 확장이 하는 일은 셋뿐이다 — ⑴ 디스크가 바뀐 것을
**알아차리고**(재계산) ⑵ 되돌릴 수 없는 문 앞에서 git 상태를 **한 줄 읽어 주고** ⑶ 발행이 끝난
뒤 「이 커밋이 그 판」이라는 표식을 **사람이 원할 때만** 남긴다.

| 항목 | 판정 | 요지 |
|---|---|---|
| GitHub API·PAT·PR·이슈 | **안 짓는다** | VS Code 의 GitHub 확장이 이미 한다. 우리가 넣으면 토큰 보관·API 추종·권한이 우리 부채가 된다(§7) |
| git 명령 실행(커밋·푸시·stash) | **안 짓는다** | 제스처 없는 쓰기. 고객 레포는 고객 것이다 |
| 디스크 변화 감지(T1) | **채택** | 지금은 **저장할 때만** 판을 다시 센다. `git pull`·`checkout`·에이전트 쓰기 뒤에 사이드바가 낡은 「일치」를 사실로 그린다(§1) |
| 문 앞 git 한 줄(T2) | **채택** | 「서버 판으로 교체」·「zip 으로 교체」·「새 버전 배포」 확인 창에 `git: main @ 1a2b3c4 · 커밋하지 않은 변경 3개`. **막지 않는다** |
| 발행 뒤 태그(T3) | **채택(오너 결정 ①)** | 성공 알림에 「git 태그 만들기」 단추. 확장이 고객 git 에 **사람의 제스처로 쓰는** 자리 — 누를 때만·깨끗한 트리에서만(T1' 의 exclude 한 줄은 커밋되지 않는 자리라 따로 본다) |
| `.zalkera/source.json` 을 `.git/info/exclude` 에(T1') | **채택** | CLI 가 `sync.json` 에 이미 쓰는 규칙과 같은 근거 — 커밋을 타고 넘어온 남의 기준점은 **거짓 상태**다(§5) |
| 교체 뒤 `.github/workflows/` 소실 | **문서 먼저** | 서버가 그 폴더를 저장하지 않아 「서버 판으로 교체」가 지운다. git 에 삭제로 뜬다(§1 ⑥). 보존은 손 목록이라 보류 |
| 판 ↔ 커밋 결속을 서버에 | **안 짓는다** | 접은 memo84 의 `commit_sha` 다. 결속은 git 태그(사람 것)로 충분하다 |
| git push → 자동 발행(Actions) | **안 짓는다(지금)** | CLI 에 헤드리스 자격이 없다(§1 ⑧). 만들면 장수 시크릿 축이라 별도 결정이다 |

⚠ **「끊김 없음」의 뜻을 좁게 잡는다.** 확장이 git 을 대신해 주는 것이 아니라, **git 이 한 일을
확장이 틀리게 말하지 않는 것**이다. 지금 어긋나는 자리는 셋이고(§1 ①②⑥) 그 셋만 닫는다.

---

## 1. 현 상태 (코드 사실)

① **판 재계산 트리거는 저장뿐이다.** `scheduleFolderVersion()` 을 부르는 자리는
`onDidSaveTextDocument` 하나이고, 파일 감시기는 없다.
재현(종전 `7b5e7b1` 기준): `git show 7b5e7b1:packages/vscode/src/extension.ts | grep -c "scheduleFolderVersion()"` → 2(호출 1 + 정의 1) ·
`git show 7b5e7b1:packages/vscode/src/extension.ts | grep -c createFileSystemWatcher` → 0.
그래서 `git pull`·`git checkout`·`git stash`·에이전트의 직접 쓰기 뒤에는 **다음 저장이나 명령까지**
사이드바 「버전」이 옛 결론을 그린다. 코드도 이 손을 안다 — 보호 경로 경고는 그래서 「열 때」도 본다
(`warnProtectedPath` KDoc). 판 재계산에는 그 둘째 갈래가 없다.

② **되돌릴 수 없는 세 문은 git 을 안 본다.** `say.serverReplaceConfirm`·`say.publishConfirm` 의
재료는 판 번호·폴더·남기는 이름·잔재다. 커밋하지 않은 변경이 있어도 아무 말이 없다.
재현: `grep -n "serverReplaceConfirm\|publishConfirm" packages/core/src/tenantScope.ts`.

③ **`.git` 은 포장·교체에서는 지켰지만 받기에서는 안 걸렀다.** 포장기가 `.git` 을 뺀다(`zip.ts` 의 배제
목록). 「zip 으로 교체」·「서버 판으로 교체」는 같은 술어로 남길 이름을 고르므로 `.git` 이 자리에 남는다
(`keepNames`). ⚠ 그러나 확장의 **tar 받기 레인**(`fetchSource.ts` 의 `extractTarGz` 셋)은 zip 레인·CLI 와
달리 배제 술어를 안 지나, 서버가 보낸 `.git/config`·`.git/hooks/*`·`.vscode/**`·`.env*` 를 그대로 놓았다
(Fable 보안 실측 — 탈취된 서버가 `core.fsmonitor` 로 폴더를 여는 순간 명령을 실행시킬 수 있는 자리).
이 트랜치에서 `decide: droppingExcluded(…)` 로 세 레인의 술어를 한 벌로 맞추고 뺀 이름을 말한다(서버가 벗기는
것은 `.git/`·`node_modules/`·`.github/workflows/`·`.env*` 뿐이라 콘솔 zip 으로 올린 판에는 `.vscode/`·`.mcp.json`·
`dist/`·`*.pem` 이 남아 있을 수 있다). 빈 폴더 항목은 `emptyDirs: true` 로 그대로 만든다(`pull` 의 「골라 쓰기」와
갈린 자리 · `untar.ts`).
재현: `grep -n '"\.git"' packages/core/src/zip.ts` · `grep -n "isExcludedEntry" packages/core/src/replaceDir.ts` ·
`grep -c "decide: droppingExcluded(" packages/core/src/fetchSource.ts` → 3 · 그물 `fetchSource.test.ts` 「받기는 zip 받기·CLI 와
같은 것을 뺀다」 + `check-wiring` 앵커 ×3.

④ **`.env.local` 은 미리보기를 켤 때 `.gitignore` 에 보장한다** — `.git/` 이 있을 때만, 없으면
만들지 않는다(`ensureEnvIgnored`). 판정 축이 「`.gitignore` 가 있는가」에서 「`.git` 이 있는가」로
한 번 고쳐진 자리다(심의 차단 2026-08-03 · `git init` 직후 키가 커밋된 실측).
재현: `grep -n "ensureEnvIgnored" packages/core/src/preview.ts packages/core/src/project.ts`.

⑤ **CLI 의 동기화 장부(`.zalkera/sync.json`)는 `.git/info/exclude` 로 감춘다** — `.gitignore` 가
아니라. 근거는 `pull.ts` 의 `ignoreLedger` KDoc: `.gitignore` 는 판이 싣고 오는 파일이라 거기
한 줄을 붙이면 두 번째 받기부터 영구 충돌한다. **확장은 이 장부를 쓰지 않는다**(CLI 전용).
재현: `grep -rn "writeLedger" packages/*/src --include="*.ts" | grep -v test` → cli·core 만.

⑥ **서버는 `.github/workflows/` 를 저장하지 않는다**(`serverNormalization.ts` 의
`EXCLUDED_PREFIXES`). 시작 소스 팩은 `ci.yml`·`client-upgrade.yml` 둘을 싣고 온다. 그래서
「서버 판으로 교체」 뒤 그 둘이 폴더에서 사라지고, git 은 **삭제 두 건**으로 보인다.
재현: `grep -n "github/workflows" packages/core/src/serverNormalization.ts`.

⑦ **폴더 소속의 정본은 `.zalkera/source.json` 이고, 없으면 `.vscode/settings.json` 의
`zalkera.tenant`** 다(`siteBinding.ts` 의 `folderBinding`). 확장이 `settings.json` 에 쓰는 것은
그 한 키뿐이다(`mergeTenantSetting`). 둘 다 비밀이 아니다.
재현: `sed -n '20,24p' packages/core/src/siteBinding.ts`.

⑧ **CLI 는 브라우저 로그인 + 홈 폴더 파일 토큰뿐이다.** 환경변수로 받는 자격증명이 없다.
재현: `grep -n "process.env" packages/cli/src/*.ts | grep -v test` → 서버 주소 하나.
GitHub Actions 에서 `zalkera publish` 를 돌리려면 refresh 토큰을 시크릿에 넣어야 하고, 그것은
**전 권한 장수 자격증명**이다 — 이 메모의 범위 밖(§7).

⑨ **`vscode.git` 확장 API**(VS Code 동봉 · `extensions/git/src/api/git.d.ts` · 2026-09-14 조회):
`getExtension("vscode.git").exports.getAPI(1)` → `API.getRepository(uri)` → `Repository.state`
(`HEAD: Branch | undefined` · `workingTreeChanges` · `indexChanges` · `untrackedChanges` ·
`refs`) · `tag(name, message, ref?)` · `getRefs(query)` · `state.onDidChange`.
⚠ **`untrackedChanges` 는 설정(`git.untrackedChanges`)에 따라 비고 `workingTreeChanges` 에 섞여
온다.** 세 배열을 **합쳐** 세야 어느 설정에서도 「커밋하지 않은 변경 N개」가 참이다.

---

## 2. 두 이력은 층이 다르다 — 그래서 확장이 git 을 대신하면 안 된다

| | 무엇을 답하나 | 단위 | 소유 |
|---|---|---|---|
| **판**(잘커라 버전 N) | 지금 손님이 보는 것이 무엇이고 무엇으로 되돌릴 수 있나 — **배포 이력** | 발행 묶음(zip 전체) | 잘커라 |
| **커밋** | 소스가 어떻게 바뀌어 왔나 — **개발 이력** | 파일 변경 | 고객 |

「배포 이력은 git 에 애초 없다」(memo76)가 이 갈래의 뿌리다. 판 원장은 git 이 없어도 서고,
git 은 판 원장이 없어도 선다. 둘을 잇는 것은 **사람이 남기는 표식**(태그·커밋 메시지의 판 번호)
하나면 충분하고, 그것을 서버에 결속하는 순간 접은 memo84 로 돌아간다.

**폴더 = 작업 트리**라는 한 가지 사실이 둘을 실제로 잇는다. 「새 버전 배포」는 HEAD 가 아니라
**지금 디스크의 파일**을 올린다. 그래서 커밋하지 않은 변경이 있으면 「이 커밋이 라이브」는 거짓이다.
T2 가 그 자리에서 말하고, T3 은 그 자리가 깨끗할 때만 태그를 권한다.

---

## 3. 접점 셋 — 어디서 맞물리나

```
 git 이 디스크를 바꾼다  ─────▶  ① 확장이 알아차린다(T1)          ── 사이드바 「버전」이 참말
 확장이 디스크를 바꾼다  ─────▶  ② 문 앞에서 git 상태를 말한다(T2) ── 「교체」 전에 커밋 여부를 안다
 확장이 판을 만든다      ─────▶  ③ 사람이 표식을 남긴다(T3)        ── 「이 커밋 = 버전 N」
```

①은 확장이 **읽기만** 하고, ②는 **모달에 한 줄**을 더하고, ③은 고객 git 에 **사람이 누른 뒤 쓴다**.
T1' 도 `.git/info/exclude` 에 한 줄을 쓰지만 그것은 커밋되지 않는 자리다(§5). 셋의 순서가 곧 위험
순서라 T3 만 오너 결정에 걸었다.

---

## 4. 트랜치

### T0 — 문서(이 판)

- `doc/MANUAL.md` §5 「git · GitHub 와 함께 쓰기」 — 개발자·대행사용 작업 순서. **지금 동작으로만**
  적는다(T1~T3 을 약속하지 않는다).
- `packages/vscode/media/help.md` 「git 과 함께 쓰기」 — 사실 절(무엇을 남기고 무엇을 안 하나).
- 이 메모.

### T1 — 디스크 변화 감지 → 판 재계산

`vscode.workspace.createFileSystemWatcher(new RelativePattern(dir, "**/*"))` 의 생성·변경·삭제
셋을 **기존** `scheduleFolderVersion()` 으로 흘린다. 1.5초 묶음은 이미 있다.

🔴 **걸러야 도는 것이 있다.** 미리보기가 도는 동안 `.next/` 가 끊임없이 바뀐다. 안 거르면 묶음
타이머가 매번 되돌아가 **재계산이 영원히 안 돈다**(기아). 거르는 집합은 손 목록이 아니라 이미 있는
술어다 — `hashWorkdir` 가 안 세는 것(`node_modules`·`.next`·`dist`… `REGENERABLE` 과 포장 배제)과
`.git/` 안쪽, 그리고 `.zalkera/` 의 우리 기록물. 같은 술어를 안 쓰면 「세지도 않는 파일이 재계산을
막는」 형상이 된다. 우리 원자 쓰기의 임시 이름(`*.zalkera-<12hex>.tmp`)도 그 술어에 넣었다 —
`rename` 직전 한순간의 사건이 묶음 경계에 걸리면 통과했다(1회전 두 축 실측).

**우리 쓰기의 창은 침묵으로 닫는다.** `whileExtracting` 이 도는 동안은 감시기를 닫고, 끝난 뒤에는
**소스 경로 사건이 2초 잠잠해질 때까지** 창을 민다(상한 30초). 고정 2초는 열렸다 — VS Code 는 감시기
사건을 200ms 마다 500개씩만 흘려보내(초당 2,500개 · `parcelWatcher.ts`) 16k 파일을 갈아 끼우면
`finally` 뒤로 3~5초(파일당 사건 1 · tmp 사건까지 안 접히면 최대 12초 — VS Code 버퍼 30k 가 상한) 동안 우리
사건이 밀려오고, 그 뒤 심은 값이 버려져 ×2 훑기가 돌아온다 — 쓰기
속도·VS Code 상수·해시 시간은 1회전 성능 **실측**이고, 「창이 열린다」는 그 위의 **모델**이다(실물
VS Code 미확인 · 2회전이 같은 상수로 시뮬레이션해 고정 2초는 16k 에서 8,000 사건 예약, 침묵 창은 0).
실측 표(1회전 성능): 사건당 거름 비용 1.7µs · Next 16 Turbopack 콜드 첫 페이지 4,101사건/s 전부
`.next/`(거름 통과 0 · 유휴 0) · 전량 해시 16k 파일 1.2초 · `git status -uall` 16k 파일 18~29ms.

대안(좁은 판): `vscode.git` 의 `repository.state.onDidChange` 만 듣는다. git 폴더에서만 듣고
git 확장이 이미 하는 감시에 얹히므로 비용이 0에 가깝다. 다만 **에이전트의 직접 쓰기**는 git 이
없는 폴더에서 못 잡는다 — 코드가 「디스크에 직접 쓰는 손」이라 이름 붙인 그 손이다. 정석은
감시기 하나로 두 손을 다 잡는 쪽이고, 감시기 비용이 실측으로 문제면 그때 좁힌다.

**검증**: 시험은 순수 함수(거름 술어)에 건다. 실물은 `git checkout` 뒤 1.5초 안에 사이드바가
「확인 중」→새 결론으로 가는지 눌러서 본다. 기아 반증은 「유휴 60초에 재계산 0」이 아니다(그것은 `.next/`
를 거르면 **정상**이다) — 미리보기가 도는 채로 파일 하나를 저장하고 1.5초 안에 재계산이 도는지가 반증이다.

### T1' — `.zalkera/source.json` 을 `.git/info/exclude` 에

표식을 쓰는 자리(`writeMarkText`)에서, `.git/` 이 **디렉터리로** 있으면 `ignoreLedger` 와 같은
방식으로 `SOURCE_MARK_PATH` 를 `.git/info/exclude` 에 한 줄 넣는다. `.gitignore` 는 건드리지
않는다(§1 ⑤ 근거 그대로). 시작 소스 팩의 `.gitignore` 는 이미 이 경로를 빼고 있으나, 고객이
직접 만든 소스에는 그 줄이 없다.

**조건은 「폴더가 레포 뿌리 · `.git` 이 디렉터리」다.** 모노레포 하위 폴더·워크트리(`.git` 파일)에서는
아무것도 안 적는다 — 폴더 밖(부모 레포)에 쓰지 않는다는 처분이고, 그 사실을 매뉴얼 §5·도움말이
말한다. 「없다」와 「못 읽는다」를 접지 않는다: exclude 가 정규 파일이 아니거나 못 읽으면 쓰지 않는다
(1회전 실측: 권한 없는 exclude 를 빈 파일로 읽고 `rename` 으로 갈아 끼워 고객 규칙이 사라졌다).
모드는 있던 그대로 넘긴다.

**왜 표식을 커밋하면 안 되나** — 표식에는 기준점(`folderVersion`·`revisionNo`)이 들어 있다. 남의
기계에서 커밋된 기준점이 `git pull` 로 넘어오면 이 폴더는 「나는 판 7 에서 왔고 그 뒤로 안
고쳤다」는 남의 사실을 자기 것으로 믿는다 — 「수정 중」·「서버가 더 최신」이 거짓이 된다.
`.vscode/settings.json` 의 `zalkera.tenant` 는 기준점이 없는 **소속 한 줄**이라 반대다 — 전용
레포라면 커밋해 두면 clone 한 사람이 열자마자 사이트가 잡힌다(§6).

### T2 — 문 앞 git 한 줄

발행(`publishCommand`)은 확인 **앞**에 `ensureEnvIgnored` 도 부른다 — 「미리보기 → `git init` → 발행」
순서면 `.env.local` 이 `.gitignore` 밖이고, 이 줄이 그것을 「커밋하지 않은 변경」으로 세며 매뉴얼은
「커밋하고 다시 누르라」고 한다 — 따를수록 열쇠가 커밋된다(1회전 보안). 포장 앞이어야 지문과 어긋나지
않는다.

`say.serverReplaceConfirm`·zip 교체 확인·`say.publishConfirm` 의 `detail` 에 줄 하나를 더한다.
재료는 `vscode.git` API 에서 읽고(§1 ⑨), 확장 쪽에서 **문자열 하나**로 접어 core 의 `say` 에
넘긴다(core 는 VS Code 를 모른다).

```
git: main @ 1a2b3c4 · 커밋하지 않은 변경 3개
git: main @ 1a2b3c4 · 깨끗함
```

- git 확장이 없거나 꺼져 있거나 그 폴더가 레포가 아니면 **줄을 안 넣는다**. 「git 없음」이라 적지
  않는다 — 그건 판정이고, 판정하려면 `.git` 을 우리가 봐야 한다.
- 막지 않는다. 「zip 으로 내보내기 먼저」 단추가 이미 있으므로 단추를 늘리지 않는다.
- 발행 로그(출력 채널)에도 같은 줄을 남긴다 — `버전 5 ← git: main @ 1a2b3c4 · 커밋하지 않은 변경 3개`(포장 뒤 값).
  나중에 「어느 커밋이 5번인가」를 묻는 자리가 출력 채널이다.

**검증**: 세 갈래(없음·깨끗함·더러움) 문면 시험 + `untrackedChanges` 설정 두 값에서 합계가 같은지.
`check-wiring` 앵커(`listRevisions` → `pickRevision` 연접)를 건드리지 않는 자리에 끼운다 —
`detail` 조립은 판정 뒤다.

### T3 — 발행 뒤 태그 (오너 결정)

발행 성공 알림에 단추 하나 — **「git 태그 만들기」**. 누르면
`repository.tag("zalkera/{site}/v{N}", "잘커라 {site} 버전 {N}", ref)`. 조건 둘을 **모두** 만족할 때만 단추가
뜬다: ⑴ 그 폴더가 레포다 ⑵ 발행 시점의 작업 트리가 깨끗했다(T2 의 재료). 더러운 트리에서 만든
태그는 라이브가 아닌 커밋을 가리키는 거짓이라 **권하지 않는다**(로그에만 남긴다).

- 태그는 **로컬**이다. 원격에 올리는 것은 VS Code 의 「태그 푸시」나 `git.followTagsWhenSync`
  이고 그것은 사람 손이다.
- 🔴 **찍는 자리는 발행 시점의 커밋이다 — 누르는 순간의 HEAD 가 아니다.** 단추는 빌드 대기(분 단위)
  뒤에 뜨고 알림은 체류한다. `tag(name, message, ref)` 의 `ref` 는 VS Code **1.107** 부터라 우리
  engine(^1.90)의 구판에서는 조용히 무시된다(1회전 실측). 그래서 누르는 순간 `readGit` 을 다시 읽어
  **HEAD == 발행 시점 커밋 && 깨끗함**일 때만 만들고, 아니면 sha 와 손 명령을 준다.
- 이름은 `zalkera/{사이트}/v{N}` — 한 레포로 여러 사이트를 돌리는 대행사에서 `zalkera/v5` 는 둘째
  사이트부터 「이미 있습니다」로 죽는다(1회전). 코드 모양이 `TENANT_CODE` 밖이면 권하지 않는다.
- `git.untrackedChanges: hidden`(폴더 설정으로 남이 정할 수 있다)이면 미추적이 **어느 배열에도** 안
  온다(`-uno`). 그때 `uncommitted` 는 `null`(셀 수 없음) — 줄은 「셀 수 없음」, 단추는 없다. `status()`
  실패·활성화 시한(5초) 초과도 `null` — 낡은 값으로 「깨끗함」을 그리지 않는다.
- 설정을 만들지 않는다. 단추는 누를 때만 쓴다 — 「매번 자동」은 제스처 없는 쓰기다.
- 「버전 전환」 목록에 `zalkera/{site}/v{N}` 태그가 있으면 `· git 태그 있음` 을 붙일 수 있다
  (`getRefs` 로 읽기). 이것은 T3 뒤의 작은 덤이고, 없어도 T3 은 완결이다.

**검증**: 태그 이름·메시지 순수 함수 시험. 실물은 더러운 트리에서 단추가 **안 뜨는지**(부정
단언의 양성 짝: 깨끗한 트리에서는 뜬다).

---

## 5. 왜 `.git/info/exclude` 인가 — 다시 적는다

`.gitignore` 는 **소스의 일부**다(판이 싣고 오고, 고객이 고친다). 우리 파일을 감추려고 거기 줄을
넣으면 ⑴ 다음 「서버 판으로 교체」가 그 줄을 지우고(서버 판의 `.gitignore` 로 돌아간다) ⑵ 되살리면
git 에 「`.gitignore` 수정됨」이 영구히 뜬다. `.git/info/exclude` 는 커밋되지 않고 판에도 안 실린다
(`.git` 이 배제 목록에 있다). 도구가 자기 파일을 감추는 표준 자리다. `.env.local` 만이 예외로
`.gitignore` 에 간다 — 그것은 **우리 파일이 아니라 고객의 비밀**이고, 그 줄은 `.gitignore` 에
있어야 다른 도구(`git add -A`·GitHub Desktop)도 지킨다.

---

## 6. 커밋해도 되는 것 / 안 되는 것 (매뉴얼 §6 의 근거)

| 경로 | 커밋 | 왜 |
|---|---|---|
| 소스 전부 · `.gitignore` · `.github/workflows/ci.yml` | O | 소스다 |
| `.vscode/settings.json`(`zalkera.tenant` 한 줄) | O — **전용 레포일 때** | 소속만 있고 기준점이 없다. 여러 사이트에 쓰는 템플릿 레포면 X |
| `.mcp.json` · `AGENTS.md` · `CLAUDE.md` | O | 열쇠가 없다(도움말이 그렇게 약속한다) |
| `.env.local` · `.env*` | **X** | 미리보기 열쇠. 확장이 `.gitignore` 에 보장한다(§1 ④) |
| `.zalkera/source.json` | **X** | 이 기계의 기준점(§T1') |
| `.zalkera/sync.json` | **X** | CLI 장부. CLI 가 스스로 감춘다(§1 ⑤) |
| `node_modules` · `.next` | X | 다시 만들어진다 |

---

## 7. DON'T-BUILD

- **GitHub API 호출 전부** — PAT 보관·PR 생성·이슈·Checks 읽기. VS Code 의 GitHub 확장이 한다.
  우리가 넣으면 「거래처 repo 를 관리하지 않는다」(memo84 접음의 불변식)가 확장 안에서 깨진다.
- **git 명령 실행** — 커밋·푸시·stash·checkout·`.gitignore` 자동 편집 확대. `.env.local` 한 줄만
  예외이고 그 예외의 근거는 §5 에 있다.
- **서버 측 레포 연결(LINKED) 재개** — 콘솔 입구가 닫힌 경로다. 이 메모는 그 반대편(고객 기계의
  git)만 다룬다.
- **git push 로 발행 트리거(GitHub Actions + CLI)** — CLI 에 헤드리스 자격이 없고(§1 ⑧), 만들면
  전 권한 장수 시크릿을 고객 레포 시크릿에 두는 축이다. 필요가 실측되면 **별도 메모**로 —
  자격증명의 범위(발행만·사이트 하나)와 수명이 먼저 정해져야 한다.
- **판 ↔ 커밋 결속을 서버에 저장** — memo84 `commit_sha`. 접은 이유가 그대로다.
- **3-way merge · 「내 변경만 남기고 갱신」** — `DECISIONS.md` 가 이미 적었다. git 이 한다.
- **확장 자체의 git 구현·번들** — `vscode.git` 이 있다. 없는 환경(git 미설치)에서는 접점이 없을 뿐
  확장은 그대로 돈다.
- **더티 트리 차단** — 「교체」·「발행」을 커밋 안 됐다고 막지 않는다. 말하고 사람이 정한다.

---

## 8. 오너 결정 (2026-09-14 · 권고대로)

1. **T3 태그** — 확장이 고객 git 에 사람의 제스처로 쓰는 자리다. 단추(누를 때만) 형태로 여는가. → **예.**
2. **`.vscode/settings.json` 커밋 권고**를 매뉴얼 §5 에 적는가 — 「전용 레포」 전제를 사람이
   판단해야 한다. → **예**(단서 포함).
3. **교체 시 `.github/workflows/` 보존** — 지금은 문서로 알린다(§1 ⑥). → **아니오**(문서로 둔다). 손 목록 없이 지키려면
   「서버가 저장하지 않는 접두는 서버 판이 지울 수 없다」는 규칙을 `keepNames` 에 얹어야 하는데
   `keepNames` 는 폴더 바로 아래 이름만 보고 `.github/` 전체는 서버가 저장하는 파일도 담는다
   (`CODEOWNERS` 같은). 부분 보존은 트리 걷기이고 그 실패면이 곧 「zip 으로 교체」가 막으려던
   사고다. 문서로 두고, 실제로 데이면 다시 연다.

---

## 9. 구현 자리 (코드 사실)

| 트랜치 | 자리 | 그물 |
|---|---|---|
| T1 | `extension.ts` `watchWorkspaceWrites` → 기존 `scheduleFolderVersion()` · 거름 `affectsFolderVersion`(core `git.ts`) · 우리 쓰기 문 `ownWriting`/`ownWritesQuietUntil`(`whileExtracting`) | `git.test.ts` 거름 양성·음성 짝 · `check-wiring` 앵커 3 |
| T1' | core `gitExclude.ts` `excludeFromGit` — `localMark.ts` `writeMarkText`·`pull.ts` `ignoreLedger`·확장 `prepareGitGate`(세 문) 가 같은 문 | `git.test.ts` exclude 11건(한 줄·보존·git 없음·gitdir 파일·`.git` 링크·잎 링크·권한·FIFO·모드·하드링크·결과) · `localMark.test.ts` 배선 2건 · `pull.e2e.test.ts` 종전 2건 |
| T2 | `vscode/src/git.ts` `readGit`(`vscode.git` API 읽기) → `say.serverReplaceConfirm`·`say.publishConfirm` 일곱째/다섯째 인자 · zip 교체 모달 인라인 | `tenantScope.test.ts` 양성·음성·개행 위조 · `check-wiring` 앵커 2 · `check-notice` 소독 |
| T3 | `tagOffer`(core) → `announcePublished(…, tag)` 「git 태그 만들기」 단추 → `createGitTag` | `git.test.ts` 권유 조건 5 · `check-wiring` 앵커 1 |

⚠ **모듈 순환 하나를 실측으로 피했다.** `git.ts` 는 `zip.ts` 를 가져오고, `zip.ts` → `provenance.ts` →
`localMark.ts` 가 `excludeFromGit` 을 부른다. 그래서 `excludeFromGit` 은 `node:fs` 만 가져오는 잎
모듈(`gitExclude.ts`)에 산다 — 처음엔 `git.ts` 에 두었다가 `PROVENANCE_PATH` 초기화 전 접근으로 시험이
통째로 죽었다.

## 10. 3축 심의

### 1회전 (`afe2260` · 2026-09-14 · Opus 셋 · 각자 detached 워크트리)

| 축 | 판정 | 잡은 것(요지) | 이행 |
|---|---|---|---|
| 기능 | **반려** | 🔴 태그가 누른 순간의 HEAD 에 찍힘 + `ref` 는 VS Code 1.107 부터라 구판에선 무시 · 🟠 `untrackedChanges=hidden` 거짓 깨끗함 · 🟠 `GitError.message` 상수라 이유 없음 · 🟠 T1' 배선·우리 쓰기 문 세우는 줄에 그물 없음(변이 생존) · 🟠 문서 「`.git` 안 건드림」·「Git 확장 꺼지면 셋 다 없음」 거짓 · 🟠 T1' 조건 미기재 · 🟡 Windows 음성 짝·zip 모달 앵커·tmp 통과·태그 이름에 사이트 없음·`.env.*` 미인식 | 전부 이행 — 누르는 순간 재확인(HEAD==발행 커밋 && 깨끗) · `uncommitted: null` · `stderr` · 시험 2건 + 앵커 6 · 문서 정정 + `RETIRED` 3 · `zalkera/{사이트}/v{N}` · `.env.*` |
| 보안 | 조건부 이수 | 🟠 같은 태그 급소 · 🟠 hidden · 🟠 `excludeFromGit` 이 「못 읽음」을 빈 파일로 접어 고객 exclude 를 갈아 끼움(실측) · 🟠 문서 절대문 · 🟡 `.env.local` 보호가 미리보기 때뿐(발행 순서에서 열쇠 커밋) · 모드 소실 · 모노레포 무동작 · 「누를 때만」 그물 없음 · `status` 실패 삼킴 · 활성화 시한 없음 | 전부 이행 — 정규 파일만·`ENOENT` 만 없음·모드 보존 · 발행 앞 `ensureEnvIgnored` · `status` 실패/시한 → `null` · 앵커 |
| 성능 | 조건부 이수 | 🟠 고정 2초 창이 큰 트리에서 열려 ×2 복귀(2,500사건/s 상한은 VS Code 소스 확인 · 창 열림은 모델) · 🟡 tmp 통과 · `status()` 상한 없음·직렬 · `distDir` 비기본은 술어 밖(종전부터) | 침묵 창(2초 슬라이딩 · 상한 30초) · tmp 술어 · `status` 3초 상한 · 교체 두 문 `Promise.all` · `distDir` 은 이 트랜치 밖(아래) |

**남긴 것(이 트랜치 밖)**: `next.config` 의 `distDir` 이 기본값이 아니면 그 폴더가 술어 밖이라 포장·지문·
감시기 모두 그것을 소스로 본다(종전부터). 고칠 자리는 술어(`zip.ts`)이고 `next.config` 를 읽는
결정이 먼저다. `hashWorkdir` 의 size+mtime 캐시(재계산 자체를 싸게)는 방향으로만 적어 둔다.
우리 쓰기 창의 정석은 시간이 아니라 **우리가 쓴 경로 집합**이다 — `refreshSiteSource`·`fetchSiteSource`
가 쓴 경로를 돌려주고 감시기가 그 집합(시한부)으로 가르면 창 안의 남의 쓰기가 안 묻힌다(2회전 기능).

### 2회전 (`cd3d0c5` · 이행 확인)

| 축 | 판정 | 요지 |
|---|---|---|
| 기능 | **이수** | 1회전 🔴1·🟠6·🟡6 전부 이행 확인(변이 8건 중 그물이 있어야 할 6건 red). 🟡 5: 재확인 갈래의 「못 읽음」 문면 · `hidden` 앵커 · 거름→창 순서 앵커 · 쓴 경로 집합(위) · 메모의 옛 태그 이름 — 앞 셋과 다섯째는 이행 |
| 보안 | **이수** | 🟠 넷 전부 실측으로 닫힘(EACCES·FIFO·링크·하드링크 · `ref` 는 1.107 경계 확인). 🟡 4: 손 명령 소독 상한 80→100 · 발행 때 `.gitignore` 실패를 로그로 + 앵커 · FIFO·권한·모드 시험(그물 없던 자리) · 문장(「쓰는 첫 자리」·「git 명령 실행」·「`.git` 이 있으면 보장」·git 이 무시하는 파일도 올라감) — 전부 이행 |
| 성능 | **이수** | 침묵 창 모델 재계산(16k: 고정 2초 8,000 예약 → 침묵 창 0 · 상한 30초는 남의 쓰기에만) · 새 비용 사건당 +0.28µs·`OWN_TMP` 0.02µs·번들 +0.7% · `within` 타이머 ≤2개(정리 넣음). 🟡 2: 「실측」→「모델」 문장 · `Promise.all` 주석 방향 — 이행 |

### Fable 3축 (`791b346` · 오너 지시 · 각자 detached 워크트리)

| 축 | 판정 | 잡은 것(요지) | 이행 |
|---|---|---|---|
| 기능 | 조건부 이수 | 🟠 태그·로그 재료가 「동의 앞」 스냅샷(모달·포장 사이의 커밋이 태그를 거짓으로) · 🟠 `.env.local`·표식 보호가 발행 문에만(교체 두 문 없음 · 첫 사용 흐름에서 표식이 「변경 1개」로 커밋) · 🟠 창 상한·`status` 실패 처분에 그물 없음(변이 M6·M7 생존) · 🟡 재확인 문면 셋째 상태 · 전역 `ownWriting` 이 옆 폴더 받기에도 · `keepNames` 가 tmp 잔재 보존 · `.env.*` 시험 · FIFO 시험 행 | 포장 뒤 `after` 스냅샷 — 앞뒤 같은 커밋·둘 다 깨끗할 때만 태그·로그 · `prepareGitGate`(세 문 · `readGit` 앞 · 연접 앵커 3) · 앵커 2 · 셋째 문면 · `whileExtracting(target)` 열린 폴더 안일 때만 문 · `isOwnTmp` · 시험 2 · FIFO 에 쓰는 쪽을 세움 |
| 보안 | 조건부 이수 | 🟠 `git.ignoreSubmodules`(폴더 설정) 도 거짓 깨끗함 · 🟠 macOS 대소문자 불일치 폴더에서 `countUncommitted` 가 전부 걸러 0 · 🟠 tar 받기 레인이 서버의 `.git/**`·`.vscode/**` 를 실현(zip·CLI 는 걸러냄 · 실측) · 🟡 `tagOffer` 가 `commit` 모양을 안 봄(`-f` 가 ref 자리면 강제) · 하드링크 exclude 그물 · 「git 명령을 실행하지 않고」 절대문 · `ensureEnvIgnored` 「보장」 과장 · `plainNotice` 가 Cf 일부(ALM·SHY·WJ·BOM·태그 문자) 남김 · exclude 실패 침묵 · `files.watcherExclude` | `blind`(hidden·ignoreSubmodules) → `null` · `dir` 이 `repo.rootUri` 의 글자 그대로 하위가 아니면 `null` · 설정 스코프 `repo.rootUri` · `fetchSource` 세 레인에 `decide: dropExcluded` · `COMMIT_SHAPE` · 하드링크·결과 시험 · `\p{Cf}` 전부 · `ExcludeOutcome` + 관문 로그 · 문서 정정 + RETIRED |
| 성능 | **이수** | 🟡 6: 해시 빈도 증가는 팩 규모 무해·1만 파일급은 캐시 트리거 없음 · T2 기다림 무표시(최악 8초) · 안 묶인 폴더 헛그리기 · 다중 루트 감시기 잔존 · 발행 때 `.gitignore` 쓰기로 1~2회 해시 · 「실측」 문구 | 500ms 넘는 해시 세션당 1회 로그 · 안 묶인 폴더 early return · 문구. 🟡-2(진행 표시)·🟡-4(`onDidChangeWorkspaceFolders`)는 다음 트랜치 |

**안 한 권고(기록)**: exclude 의 `chmod` 를 rename 앞(tmp)으로 — 같은 사용자 경쟁이라 값이 작다 · `writeViaRename` 에
「정확한 모드」 선택지는 `.env.local` 모드를 넓힐 위험이 있어 보류 · `ensureEnvIgnored` 실패를 확인 창 한 줄로 —
로그로 둔다 · tar 레인의 낙하 이름 로그(zip 레인은 댄다 — `decide` 는 `skip` 만 돌려줘 이름을 모으려면 클로저) ·
`decide` 가 있으면 해제기가 **빈 폴더 항목**을 안 만든다(git 이 관리하는 소스에는 빈 폴더가 없어 팩·확장 발행분은
무영향 · 콘솔 zip 으로 올린 판의 빈 폴더만 받기에서 사라진다 — `untar.ts` type-5 갈래에 `decide` 를 물리는 것은 CLI
`pull` 의 「손대지 않았다」 계약과 함께 봐야 한다) · 교체 뒤 `.gitignore` 는 서버 판의 것이라 `.env.local` 줄 보장이
일시적(미리보기·다음 문에서 다시 보장 · 교체 직후에 넣으면 지문이 서버와 갈려 「수정 중」이 뜬다 — 트랜치 전부터의 틈).

### Fable 이행 확인 (`5cea5c5` → `266c7f1` → 이 판)

| 축 | 판정 | 요지 |
|---|---|---|
| 성능 | **이수** | 새 비용 전부 µs~sub-ms(`\p{Cf}` 0.4~1.3µs/호출 · 관문 0.2ms · 표식 읽기 9µs/사건 → 묶음 첫 사건만) · 번들 +0.65% · 회귀 0 |
| 보안 | **이수** | 🟡-A 그물(앵커 ×3 + 양성 시험 · 변이 M21/M22 red) · `emptyDirs` 가 `skip` 폴더를 안 만드는지 실측 · 🟡 둘(`skip` 폴더 갈래 그물 → `{dir: ".git"}` 픽스처 · 폴더 항목을 파일로 셈 → 폴더는 `/` 를 붙여 묻는다) 이행 |
| 기능 | **이수** | ⒜~⒠ 실물 확인 · 앞 회전 생존 변이 넷(M8·M18·M19·M14) 전부 red · 🟡 둘(폴더 `/` · FIFO `spawn` `error` 리스너) 이행 |

⚠ **한 회전에서 보고와 실물이 갈렸다.** `.env.*` 시험과 FIFO 쓰는 쪽이 「들어갔다」고 보고됐는데 편집 스크립트가 중간에
멈춰 실제로는 없었다(기능 Fable 이 diff 로 잡음). 「고쳤다」 전에 diff 를 다시 읽는 규율의 실례로 남긴다.

**남은 실물 확인(이 박스에 VS Code 가 없다)**: 침묵 창이 실제 감시기 드레인을 덮는가 · `git.untrackedChanges`
폴더 설정이 실제로 흘러드는가 · 활성화 시 감시기가 중복 기동되지 않는가. 오너 박스의 데스크톱 VS Code 에서
「서버 판으로 교체」 뒤 사이드바가 「확인 중」을 거쳐 한 번만 세는지, 미리보기가 도는 채로 파일 하나를
저장해 1.5초 안에 재계산이 도는지(그리고 유휴 60초에는 안 도는지)를 눌러 보는 것이 그 확인이다.

## 11. 관련

- `DESIGN-server-replace.md` §9 DON'T-BUILD(더티 검출 기각) — T2 는 검출이 아니라 **인용**이다.
  판정하지 않고 git 이 말하는 것을 그대로 옮긴다.
- `DECISIONS.md` 「동시 업로드 — 덮어쓰기 방어」 — 3-way merge 는 git 수준.
- `packages/core/src/pull.ts` `ignoreLedger` — `.git/info/exclude` 의 근거.
