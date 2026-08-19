# `zalkera-devtools` 발행 절차

> **이 문서가 생긴 이유.** 레포 루트에서 `npx vsce publish` 를 부르면 이렇게 죽는다:
>
> ```
> ERROR  Missing vscode engine compatibility version.
>        ("engines": { "vscode": "<version>" } in package.json)
> ```
>
> 확장은 **npm 워크스페이스 멤버**(`packages/vscode`)라 `vsce` 가 **레포 루트를 패키지 루트로**
> 잡는다. 루트 `package.json` 은 모노레포 루트라 `engines` 가 없다. `scripts/package-vsix.mjs`
> 가 그 함정을 피하려고 워크스페이스가 없는 스테이징에서 포장하는데, 그 사실이 어디에도 안
> 적혀 있어 발행하는 사람이 매번 같은 자리에서 막혔다.

---

## 0. 언제 버전을 올리나

`packages/vscode/package.json` 의 `version` 이 마켓의 그것과 같으면 **마켓이 재발행을 거절한다.**
소스를 고쳤으면 반드시 올린다.

**등급**:

- **patch** — 고객이 보는 동작이 그대로이거나 결함만 사라지는 변경(성능·거짓 경고 제거·문면).
- **minor** — 고객이 보던 것이 달라지는 변경. 명령·설정·알림 문면이 바뀌거나, **검사기가 새로
  경고를 내는** 경우가 여기다. 진단은 편집기에 바로 뜨므로 「지금까지 안 뜨던 것이 뜬다」는
  고객에게는 동작 변경이다.

⚠ **버전 드리프트를 잡는 검사기가 없다.** `npm run verify` 의 검사기 어느 것도 `version` 을
마켓과 대조하지 않는다. 그래서 아래 §3 의 태그가 유일한 기록이다.

---

## 1. 굽기

```bash
cd zalkera-devtools
npm run package          # 버전은 이미 올려 둔 값으로. 올리면서 구우려면 package:patch / package:minor
```

`npm run verify`(시험 + 검사기 전량)를 먼저 돌리고, `dist/zalkera-devtools-<version>.vsix` 와
`shared/` 사본을 만든다. **`vsce` 는 이 스크립트 안에서만 부른다** — 직접 부르면 위 오류가 난다.

산출물이 이번 변경을 실제로 담았는지 확인한다:

```bash
unzip -p dist/zalkera-devtools-<version>.vsix extension/dist/extension.cjs | grep -c '<식별자>'
```

⚠ **비-ASCII 로 grep 하지 마라.** esbuild 는 문자열 리터럴의 한글을 `\uXXXX` **대문자 16진**으로
이스케이프한다(주석은 그대로 남는다). 한글로 찾으면 「수정이 번들에 없다」고 오보한다.
식별자·ASCII 패턴으로 찾을 것.

---

## 2. 발행 (오너)

```bash
npx vsce publish --packagePath dist/zalkera-devtools-<version>.vsix
```

**이미 구운 파일을 올린다.** `--packagePath` 없이 부르면 `vsce` 가 다시 포장하려 들면서 §0 의
오류가 난다.

발행은 마켓플레이스 자격증명이 필요하다 — **오너만 할 수 있다.** 에이전트는 여기서 멈추고
그 사실을 말한다.

---

## 3. 발행 **다음** — 태그를 찍는다

`dist/*.vsix` 는 gitignore 다. 태그를 안 찍으면 **어느 트리가 나갔는지 아무 데도 안 남는다.**
실제로 한 번 그랬다 — 같은 버전 번호로 커밋 열 개가 쌓여, 마켓의 그 버전이 무엇인지 레포
안에서 판별할 수 없었다.

```bash
BUNDLE=$(unzip -p dist/zalkera-devtools-<version>.vsix extension/dist/extension.cjs | sha256sum | cut -d' ' -f1)
VSIX=$(sha256sum dist/zalkera-devtools-<version>.vsix | cut -d' ' -f1)
git tag -a v<version> -m "발행본 sha256: vsix $VSIX · bundle $BUNDLE
재현: npm run package && sha256sum dist/zalkera-devtools-<version>.vsix" HEAD
git push origin v<version>
```

빌드가 결정론적이라(esbuild + zip mtime 고정) 이 sha 로 **나중에도 대조할 수 있다.**
그것이 이 태그의 값어치다 — 번호만 적으면 다음 사람이 못 되짚는다.

---

## 4. 체크리스트

```
[ ] packages/vscode/package.json 의 version 을 올렸다
[ ] npm run package  (verify 통과 + vsix 생성)
[ ] 번들에 이번 변경이 들어갔는지 ASCII 패턴으로 확인
[ ] npx vsce publish --packagePath dist/…vsix   (오너)
[ ] v<version> 태그를 sha256 과 함께 찍고 push
```
