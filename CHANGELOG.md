# Changelog

Every release of SoloW, written from its commits by [git-cliff](https://git-cliff.org) — see
`cliff.toml`. Versions follow [Semantic Versioning](https://semver.org); the number itself is
decided by `packages/cli/scripts/next-version.ts` from the same commits.

## [0.21.0](https://github.com/Satcomx00-x00/SoloW/compare/v0.20.1...v0.21.0) — 2026-10-06

### Features

- **harness:** Apply opencode's --auto as the ACP client ([`05d210b`](https://github.com/Satcomx00-x00/SoloW/commit/05d210b4c0cef595f6eb662f1d3b84841816dbb3))
- **db:** Seed opencode with --auto, and give it to existing rows (0046) ([`5ca55ed`](https://github.com/Satcomx00-x00/SoloW/commit/5ca55ed2cdd798c75764dd6c3e6ddb42b300403e))

## [0.20.1](https://github.com/Satcomx00-x00/SoloW/compare/v0.20.0...v0.20.1) — 2026-10-06

### Fixes

- **acp:** Pin a model through session/set_config_option where it was offered ([`cf477cf`](https://github.com/Satcomx00-x00/SoloW/commit/cf477cfc3f277a1be54aaefd04d93bba57573ddf))
- **harness:** Say why an ACP session ended, not a bare "fail" ([`0dedf4f`](https://github.com/Satcomx00-x00/SoloW/commit/0dedf4ff694852f2d3c6792ace00b6d926875d3d))

## [0.20.0](https://github.com/Satcomx00-x00/SoloW/compare/v0.19.0...v0.20.0) — 2026-10-06

### Features

- **web:** Replace the activity rail and navigator with one labelled sidebar ([`3f724e0`](https://github.com/Satcomx00-x00/SoloW/commit/3f724e0c098ed43cd460b8a958b410266a30b7c3))
- **web:** Count unassigned issues on the server ([`6ea4a9c`](https://github.com/Satcomx00-x00/SoloW/commit/6ea4a9ce98d4d808dcbfba798b2064ca2270070c))
- **web:** Keep the sidebar's counts live ([`ba7493f`](https://github.com/Satcomx00-x00/SoloW/commit/ba7493f6be6d05312c33f89b677b902415ef69bb))
- **web:** Show tasks awaiting review in the sidebar ([`1488b57`](https://github.com/Satcomx00-x00/SoloW/commit/1488b57c60e869b62c09379e2ed6224a7c5e3fca))
- **web:** Load recent tasks in one request ([`360db7c`](https://github.com/Satcomx00-x00/SoloW/commit/360db7c90fea272d395c6c40e706c2db4ff23ed6))
- **web:** Name each recent task's project in the sidebar ([`5a93c4a`](https://github.com/Satcomx00-x00/SoloW/commit/5a93c4a29b296c88c97de8c71103892a52f47be5))
- **web:** Jump to projects from the command palette ([`ea238ef`](https://github.com/Satcomx00-x00/SoloW/commit/ea238efd90122a9a9ad85aae722d578061f24ac3))
- **web:** Filter the sidebar's projects once there are many ([`369379e`](https://github.com/Satcomx00-x00/SoloW/commit/369379e9755c96bc1df3acf55281d01071032587))
- **web:** Peek at the hidden sidebar from the left edge ([`0d52904`](https://github.com/Satcomx00-x00/SoloW/commit/0d529048a109a370d8b0ca87361a2ad6652e80cf))
- **web:** Resize the sidebar by dragging its edge ([`3d56a55`](https://github.com/Satcomx00-x00/SoloW/commit/3d56a5587e44cc7b12e0b632c5ab2c9eb7984497))
- **web:** Drop the Task page's back arrow for the breadcrumb ([`adcbcb6`](https://github.com/Satcomx00-x00/SoloW/commit/adcbcb6524c915f248df43f868f58ad256ace6a2))
- **workflows:** An agent-decides gate, and a review forced per Task ([`8a3e16b`](https://github.com/Satcomx00-x00/SoloW/commit/8a3e16b2df6f3996c98cc6369730fc4f291081c3))
- **sessions:** Read which Steps of a Task finished, and why ([`556bbc5`](https://github.com/Satcomx00-x00/SoloW/commit/556bbc51e03cfa265ed730b41609507f6843562c))
- **terminal:** An interactive shell in the Task's worktree ([`6a501a2`](https://github.com/Satcomx00-x00/SoloW/commit/6a501a2c17b912dd2bdabe3ba562864f60ce554f))
- **web:** The Task page becomes a board ([`6592165`](https://github.com/Satcomx00-x00/SoloW/commit/65921652d78ce16964c2ebc40294791b0ea03d77))
- **web:** The running Step and the one waiting on you breathe ([`476bcee`](https://github.com/Satcomx00-x00/SoloW/commit/476bceef43f442f25665af233b73912864d4df64))
- **web:** Say how a plan's open items get settled ([`8c9abb8`](https://github.com/Satcomx00-x00/SoloW/commit/8c9abb89e159175964f7461277542a620d48664e))

### Fixes

- **web:** Settings' back link survives a reload ([`2474a96`](https://github.com/Satcomx00-x00/SoloW/commit/2474a967bddd4cc603932d956a6b0cc22c960490))
- **web:** Keep keyboard focus when the sidebar is shown or hidden ([`03b7308`](https://github.com/Satcomx00-x00/SoloW/commit/03b7308c4a598b7056db9c972c42259418095eea))
- **web:** Name a recent task's project by its initial, not in words ([`a3513aa`](https://github.com/Satcomx00-x00/SoloW/commit/a3513aad19c38feca2891c35d3ca051c7f0db437))
- **stack:** Keep Inngest state across restarts of start.sh ([`e2eee5c`](https://github.com/Satcomx00-x00/SoloW/commit/e2eee5c727f3f8a53f1e3e1f1c8f62d7720093f8))
- **review:** Refuse a decision whose run is known to be gone ([`e69cb40`](https://github.com/Satcomx00-x00/SoloW/commit/e69cb40e6354b59116ae2b1ac3e670150a6c9b9c))
- **harness:** Adopt a legacy hermetic home instead of starting empty ([`5374fc3`](https://github.com/Satcomx00-x00/SoloW/commit/5374fc34b4792042f2c1a4d515570b4631907f11))
- **workflows:** Apply settled decisions on their own Step before moving on ([`9c56de1`](https://github.com/Satcomx00-x00/SoloW/commit/9c56de12955d14ecd9e3a1946ecfde4691e695d1))
- **harness:** An open question is a decision, not a marker ([`85fb6cb`](https://github.com/Satcomx00-x00/SoloW/commit/85fb6cbb81674e131e7b344c144c7760eb4b251d))
- **web:** Light Workflows itself while there is no pipeline ([`dbd94f8`](https://github.com/Satcomx00-x00/SoloW/commit/dbd94f82d0eb939e4e179a5158346879ea810c45))
- **deps:** Take source-map-js 1.2.2 for its event-loop DoS fix ([`6b766a1`](https://github.com/Satcomx00-x00/SoloW/commit/6b766a14ea304093ef27a1ba08e62502a071d37c))
- **web:** Turn off the Next dev badge ([`c276d4b`](https://github.com/Satcomx00-x00/SoloW/commit/c276d4bda89ade3a1c219d7975eb704c68b9ebc3))

### Refactoring

- **web:** Drop the header's Step strip for the board's own Steps ([`ff38963`](https://github.com/Satcomx00-x00/SoloW/commit/ff389636b6c3d247718dd30cc649686b8e17642a))

### Tests

- **web:** Cover navigation, the sidebar, workflow creation and the board's cards ([`a7c6fbe`](https://github.com/Satcomx00-x00/SoloW/commit/a7c6fbe94bbab3819c91099d61dac7144183275a))
- **orchestrator:** Cover the settled-decisions brief ([`d162370`](https://github.com/Satcomx00-x00/SoloW/commit/d1623708f5f83c8e816e88e1e5aeb6cbc3bc678d))
- **orchestrator:** Drop a duplicate test helper ([`3ff7ebf`](https://github.com/Satcomx00-x00/SoloW/commit/3ff7ebfce3eace82189c0961d23617399cea5de8))
- **web:** Stub next/navigation in the LaunchTaskDialog test ([`bb4ddc8`](https://github.com/Satcomx00-x00/SoloW/commit/bb4ddc801b3f663110af7b0d2c5593d9b18b9712))
- Smoke the API's navigation path and the shell in a browser ([`1059a76`](https://github.com/Satcomx00-x00/SoloW/commit/1059a7699357ad9500abca519fbb10a358c04e3d))
- **e2e:** Read a multi-Repository change on the Changes tab ([`5ce7673`](https://github.com/Satcomx00-x00/SoloW/commit/5ce7673189e0a9a041ecaa99af694c0fb12e3b43))
- **e2e:** Wait for Unassigned's own issues, not the old sidebar's count ([`4f5c859`](https://github.com/Satcomx00-x00/SoloW/commit/4f5c859a66a81e1af523d77830387ef1b207cf21))
- **e2e:** Reach the brief through the gate's criteria row ([`6308294`](https://github.com/Satcomx00-x00/SoloW/commit/63082941690b707e368026e3e6cf57f3dc2c62f8))
- **e2e:** Read one criterion at a time, and the stop from the Session log ([`55767f1`](https://github.com/Satcomx00-x00/SoloW/commit/55767f17f4898e8ddc25a483cd85d859a050dee2))

### Maintenance

- **web:** Move the Next dev badge off the sidebar's Settings link ([`522b509`](https://github.com/Satcomx00-x00/SoloW/commit/522b5094a5734a2b725a75f2251f34061d3cd629))
- **deps:** Bump turbo to 2.11.7 ([`9fc1dca`](https://github.com/Satcomx00-x00/SoloW/commit/9fc1dca5f01eb6e7fdc89c64678172e013ca1892))

## [0.19.0](https://github.com/Satcomx00-x00/SoloW/compare/v0.18.0...v0.19.0) — 2026-10-02

### Features

- **harness:** Store harness configs in the app, not the host ([`f885236`](https://github.com/Satcomx00-x00/SoloW/commit/f8852365eb6a69d3f4de960d5f444b74581d36e6))
- **opencode:** Upgrade the bundled harness to OpenCode 2 (@opencode/cli 2.0.22) ([`914ebdf`](https://github.com/Satcomx00-x00/SoloW/commit/914ebdfda374b26d9179fb5aec93d7beb96f592b))

### Tests

- **web:** Give catalog fixtures the command a config picker reads ([`93a5e5e`](https://github.com/Satcomx00-x00/SoloW/commit/93a5e5ef03cace859644dccbfa10b8bfe2abe2d8))
- **web:** Harness configs follow Harness profiles in the Harnesses group ([`7285cd8`](https://github.com/Satcomx00-x00/SoloW/commit/7285cd8c7b8e3c58766f4a0ba090d78916fe9792))

## [0.18.0](https://github.com/Satcomx00-x00/SoloW/compare/v0.17.3...v0.18.0) — 2026-09-30

### Features

- **task:** The footer says what this task needs now ([`bec03ef`](https://github.com/Satcomx00-x00/SoloW/commit/bec03efd3b9cede98c76c219ff004b32fecf18f8))
- **task:** A blocked task says what it waits on ([`ae8ee06`](https://github.com/Satcomx00-x00/SoloW/commit/ae8ee06377b1c8ee0de0ce0f597e13cfb2f88f18))
- **task:** The header answers "which profile, which base, since when" ([`f36d8b4`](https://github.com/Satcomx00-x00/SoloW/commit/f36d8b4ecec9b85471c8d9e9d446d424342a6570))
- **task:** A composer that queues, expands and explains itself ([`969f7b5`](https://github.com/Satcomx00-x00/SoloW/commit/969f7b59e29e0c4afd0d0209102a79f1239eb0a3))
- **task:** Filter the transcript by what it shows ([`443aa40`](https://github.com/Satcomx00-x00/SoloW/commit/443aa40d70b91b66cc44ad9713a75fb019822593))
- **task:** The right column is tabbed — Changes, Plan ([`cf00e9e`](https://github.com/Satcomx00-x00/SoloW/commit/cf00e9e5b8963b713c39329d35c9d05417e14aea))
- **task:** The changes panel states its size and its risks ([`ac6cc7a`](https://github.com/Satcomx00-x00/SoloW/commit/ac6cc7aeb196305aa76ce2b5c5884664cbbedc71))
- **task:** Every review round stays readable ([`c61ed40`](https://github.com/Satcomx00-x00/SoloW/commit/c61ed4095d362b30e835efd015d87d232a7d97b2))
- **task:** Tick files off as you read them ([`79d13ad`](https://github.com/Satcomx00-x00/SoloW/commit/79d13add8180e005f04904a9b74d32741b05acd0))
- **task:** Request changes carries the reviewer's notes ([`c0d3e7d`](https://github.com/Satcomx00-x00/SoloW/commit/c0d3e7d2fac00ef7f480f74e03d5ee333358d81b))
- **workflows:** A run that reaches a human-decided Step opens the gate itself ([`ae2ad4d`](https://github.com/Satcomx00-x00/SoloW/commit/ae2ad4d7274593b660b5e6e2ed72f8a14cda66aa))
- **task:** Delete moves a task to history for 7 days ([`6558bf9`](https://github.com/Satcomx00-x00/SoloW/commit/6558bf9eb954f3f5a9dcabcfb1a01f24763727fe))
- **task:** A done task can be reopened ([`652bf8d`](https://github.com/Satcomx00-x00/SoloW/commit/652bf8d0d43bedd20f0a88c9906a590d81b7abbf))
- **orchestrator:** Worktrees and history live 7 days ([`4f2008f`](https://github.com/Satcomx00-x00/SoloW/commit/4f2008f4d86cdaa1894c2cf1e0d0c323e2707b50))
- **orchestrator:** A relaunched task continues its conversation ([`37980a9`](https://github.com/Satcomx00-x00/SoloW/commit/37980a98b4707bafdc11aad3b178de61d20dddd4))
- **executor:** Containerised runs keep their transcripts ([`1b9e40d`](https://github.com/Satcomx00-x00/SoloW/commit/1b9e40d7b06594a8ccc189cae70553fa4399df14))
- **history:** A history of closed and deleted tasks, with resume ([`7ef372f`](https://github.com/Satcomx00-x00/SoloW/commit/7ef372fbf269d1a69abb5edb5ebdf295c51cc789))
- **task:** What the harness left undone is listed at the gate ([`c52818e`](https://github.com/Satcomx00-x00/SoloW/commit/c52818e55277be0015014b02d54c403a52f3f06c))
- **task:** The change reads in order of consequence, with a tool's output folded ([`db8df8f`](https://github.com/Satcomx00-x00/SoloW/commit/db8df8fadf6b5b3c3215caf741925d05bc3b6c75))
- **task:** A Review tab that lines the ask, the claim and the evidence up ([`fb7971a`](https://github.com/Satcomx00-x00/SoloW/commit/fb7971ad918289cde9a6278fe9165c63738431ac))
- **workflows:** A decision the harness made can be overturned on the Plan tab ([`fc6af0b`](https://github.com/Satcomx00-x00/SoloW/commit/fc6af0b27d96a49d9822d9431dddd3e4e2f1851c))
- **workflows:** A Step can declare checkpoints a person waves through while it runs ([`a23404e`](https://github.com/Satcomx00-x00/SoloW/commit/a23404ef9b075e8f2fc7a6bc31a6da5249b85cbb))
- **task:** The Task page is tabbed — Run · Brief · Plan · Changes — on one Tabs primitive ([`8cbbdd6`](https://github.com/Satcomx00-x00/SoloW/commit/8cbbdd6328b330e405dcee89eff2051eb8229179))
- **task:** The tabbed Task page and the Tabs primitive — the files 8cbbdd6 left behind ([`252cf90`](https://github.com/Satcomx00-x00/SoloW/commit/252cf90f7849bd659f6d39fe0ad7353f0d224923))
- **task:** The Task page as evidence and dossier — a rail beside the run, the decision at its foot ([`c84a67f`](https://github.com/Satcomx00-x00/SoloW/commit/c84a67f27e671d111903475e11c36ff2cf699f83))
- **task:** The workflow run sits in the header bar, not the rail ([`1dd94f6`](https://github.com/Satcomx00-x00/SoloW/commit/1dd94f6e3ac3ca9381e86ece5edb5a55a05a27db))
- **task:** "Explain" on every acceptance criterion — a plain-language reading, in the harness's context ([`975c067`](https://github.com/Satcomx00-x00/SoloW/commit/975c067b8a67c169c6ff0890d6bc7bd6c8a5752c))
- Hermetic harness home, Settings controls, run links, Skill locators, flags ship on ([`fc3304d`](https://github.com/Satcomx00-x00/SoloW/commit/fc3304d1d999cc9a46b559deed01fb18d20b211b))
- **tasks:** A Task can have sub-tasks, with a hash-verified fork point ([#56](https://github.com/Satcomx00-x00/SoloW/issues/56)) ([`027ac72`](https://github.com/Satcomx00-x00/SoloW/commit/027ac72a58872f9e3e3ca9bf8958cd228bda7887))
- **tasks:** Split, re-parent, and brief a sub-task from its parent's transcript ([#56](https://github.com/Satcomx00-x00/SoloW/issues/56)) ([`e727ea4`](https://github.com/Satcomx00-x00/SoloW/commit/e727ea444eff6cce7f15471ec23bb55b830d19d2))
- **tasks:** Sub-tasks on the Task page and the board ([#56](https://github.com/Satcomx00-x00/SoloW/issues/56)) ([`6c88259`](https://github.com/Satcomx00-x00/SoloW/commit/6c88259d537046ae7fb9ae777c9e05a68c5354b7))
- **acp:** Read which build answered the handshake, and refuse one below a pin ([`27447c8`](https://github.com/Satcomx00-x00/SoloW/commit/27447c831665e6d0ad1d15dd23f4264b6b1b8aed))
- **harness:** Pin opencode to 1.18.33 — a catalog minimum version, checked on every run and probe ([`083cb9d`](https://github.com/Satcomx00-x00/SoloW/commit/083cb9da5ad31bee611f32716810f0da06ca644a))
- **harness:** SoloW installs opencode itself — opencode-ai@1.18.33 as an npm dependency ([`63952d0`](https://github.com/Satcomx00-x00/SoloW/commit/63952d029790241a090afa15ce2e1636a9822ccf))

### Fixes

- **task:** The transcript filter bar is a fieldset, so its label is legal ([`c2bb9aa`](https://github.com/Satcomx00-x00/SoloW/commit/c2bb9aa14588908d204b4e60b64e6721c764cfe0))
- **task:** Ticks and notes only at the gate, a mode chip that reads as one, unique hunk keys ([`0c87e30`](https://github.com/Satcomx00-x00/SoloW/commit/0c87e30cdca7ae0d9b167792921770101983ca76))
- **task:** One "Move to Ready" per page — found by the control check ([`b534e85`](https://github.com/Satcomx00-x00/SoloW/commit/b534e85df6a5c7faf52699878d31dd7fbf921a6e))
- **orchestrator:** Never adopt the repository's own working tree as a Task's worktree ([`5503822`](https://github.com/Satcomx00-x00/SoloW/commit/550382267baeae9696ce5a1baea63c728204f16d))
- **workflows:** A plan-only Step can reach its gate, and its plan shows on the Plan tab ([`ce75537`](https://github.com/Satcomx00-x00/SoloW/commit/ce75537f63f6615fe17717c42721d2a07788b069))
- **task:** The footer says a finished run has finished ([`372e30d`](https://github.com/Satcomx00-x00/SoloW/commit/372e30dde8974c09a52c96ae21406de03c0dc664))
- **task:** "Open review" sits in the footer, with the decisions ([`1c6aff6`](https://github.com/Satcomx00-x00/SoloW/commit/1c6aff666a7512efee253bea7bfbf93606d7143e))
- **orchestrator:** A decision on an earlier gate is not a stranded one ([`f815f67`](https://github.com/Satcomx00-x00/SoloW/commit/f815f67add28d7e703e4f597bf2817b943ecd56b))
- **issue:** A task in History no longer blocks deleting its issue — found by the control check ([`18d7d36`](https://github.com/Satcomx00-x00/SoloW/commit/18d7d367f87d921873c495ddb50b6c4500db2729))
- **history:** Deleting an issue removes its tasks' worktrees from disk — found by the control check ([`ccc8218`](https://github.com/Satcomx00-x00/SoloW/commit/ccc821845c71bc3bae7289506cd43c98a0691935))
- **task:** The Task page's UX audit — keyboard tabs, contrast, undo, live controls, one error system ([`93f6b83`](https://github.com/Satcomx00-x00/SoloW/commit/93f6b83fad4fd0ceb6a8ec4c8b3b28f391ec2d3c))
- **task:** The second UX audit of the Task page — one copy of each verb, no frames, honest counts ([`b8e3743`](https://github.com/Satcomx00-x00/SoloW/commit/b8e3743ac43140bbda871090204898ebdba8955a))
- **task:** Explain asks the Task's own harness, not an API client ([`fb25a55`](https://github.com/Satcomx00-x00/SoloW/commit/fb25a553268f11e1592b216293710e7672ac5255))
- **e2e:** The multi-Repository isolation case counts checkouts, not the harness home ([`bfa05eb`](https://github.com/Satcomx00-x00/SoloW/commit/bfa05eb3cb22e8544529b1310550271fec6abbe3))
- **audit:** The two quality gates main was failing ([`887ff5b`](https://github.com/Satcomx00-x00/SoloW/commit/887ff5bee0a26d9b50115bcfc3b2caed43809e37))
- **tasks:** A sub-task's digest caps the work it shows, not the machinery around it ([`3c880d9`](https://github.com/Satcomx00-x00/SoloW/commit/3c880d93465638c35aafe861ff9918ac4509ab44))
- **settings:** "Try again" on Task defaults retries the choice that failed ([`8ca8dfc`](https://github.com/Satcomx00-x00/SoloW/commit/8ca8dfc5a0431f8ac88b3f2eb0d4a222f59e1533))
- **settings:** Two quick picks in Task defaults no longer lose the first ([`ec62491`](https://github.com/Satcomx00-x00/SoloW/commit/ec62491ef4fa68d1fd3d6cefe6166199ccbbf531))
- **web:** One test env for every server test, so the suite no longer depends on file order ([`d372b55`](https://github.com/Satcomx00-x00/SoloW/commit/d372b558fbd766539e5185bb48571ae97e6377a7))
- **tasks:** A sub-task split right after opening its parent appears in the list ([`04d3034`](https://github.com/Satcomx00-x00/SoloW/commit/04d3034bbcbef068f33dd9ad1a2c3a088a661c86))
- **web:** The theme hook no longer paints dark before reading the cache ([`71c1054`](https://github.com/Satcomx00-x00/SoloW/commit/71c1054fdf1cf14aa34e4a7c72385ee34010569f))
- **tasks:** Restore right after opening a Task shows the sub-tasks it brought back ([`72d3487`](https://github.com/Satcomx00-x00/SoloW/commit/72d34873a8063950867c6ffd29f2a5070e3629a5))
- **web:** A theme chosen right after opening Settings is no longer reverted ([`035ab51`](https://github.com/Satcomx00-x00/SoloW/commit/035ab51703c33f6995c0b18a63aae866644041b7))

### Documentation

- **history:** F02 and F11 record what History and the resumable state ship as ([`f226309`](https://github.com/Satcomx00-x00/SoloW/commit/f226309acf396d3cb449abd6e5535f6b50e9fcac))
- **tasks:** F02 FR-12 as built, and a sub-task in the isolation suite ([#56](https://github.com/Satcomx00-x00/SoloW/issues/56)) ([`647b93b`](https://github.com/Satcomx00-x00/SoloW/commit/647b93b7b104a7e97265282cf19b6f08b9a08454))

### Tests

- **e2e:** The control checks assert the launch, not a Running state they may never see ([`0a5e3fb`](https://github.com/Satcomx00-x00/SoloW/commit/0a5e3fb16df34dae48fae37503c744b7d03cdcd2))
- **e2e:** Give the cleanup navigation the time a cold board compile needs ([`ca71a2d`](https://github.com/Satcomx00-x00/SoloW/commit/ca71a2dae51672abbb7aee5ff07b87a666cb51c6))
- **e2e:** The Task page's new interactions, in the full suite and the control check ([`90581fc`](https://github.com/Satcomx00-x00/SoloW/commit/90581fc67b4cf78c1b6da1a80cf651d7ddf4f6f1))
- **control:** The 20-minute budget 90581fc described but did not carry ([`02547c3`](https://github.com/Satcomx00-x00/SoloW/commit/02547c3738f1da2b78a60b961b5b84bd64b42081))
- **workflows:** The Workflow store's behaviour — bound Skills, defaults, tenancy, sync refusals ([`1be1796`](https://github.com/Satcomx00-x00/SoloW/commit/1be17966e65547e61a30e73c2421124518b71ca4))
- **control:** Drop the 600s timeout that overrode 02547c3's 20-minute budget ([`9ebf48e`](https://github.com/Satcomx00-x00/SoloW/commit/9ebf48ebdb25c7315a982987108afb123d1b5e13))
- **web:** The project picker, the theme hook and the pre-paint script ([`99f5761`](https://github.com/Satcomx00-x00/SoloW/commit/99f5761d28ef9d54b96c0b2d05c362339e529714))
- **e2e:** Sub-tasks, workspace controls and the harness home, end to end ([`004bbc5`](https://github.com/Satcomx00-x00/SoloW/commit/004bbc5396d903b6201179262af7ec26365dc7f2))
- **e2e:** The isolation suite gets the six-minute budget the others have ([`888d6ea`](https://github.com/Satcomx00-x00/SoloW/commit/888d6ea2d4f6f8a917928320dbe7aa85ea48198e))
- **e2e:** The theme-at-parse check says which half failed, and waits for the cache ([`21217f0`](https://github.com/Satcomx00-x00/SoloW/commit/21217f05ccdb3d006c74aab9bc439c20fb0f343e))

### Build and CI

- **release:** Git-cliff writes CHANGELOG.md and each GitHub Release's notes ([`9b62f0a`](https://github.com/Satcomx00-x00/SoloW/commit/9b62f0acc986a2647568445ee20ec3e5d6793cc9))
- **hooks:** Prek runs the git hooks — gitleaks, biome, shell, and a commit-msg check ([`1da278b`](https://github.com/Satcomx00-x00/SoloW/commit/1da278bf11760e307e23eddc33192629ed7d817c))
- **verify:** Shard the E2E suite across three runners ([`c51d237`](https://github.com/Satcomx00-x00/SoloW/commit/c51d237811d96da41ec3a68ad527054ae65aba3d))

## [0.17.3](https://github.com/Satcomx00-x00/SoloW/compare/v0.17.2...v0.17.3) — 2026-09-10

### Fixes

- **workflows:** The branch editor keeps both of two quick edits, and a fit never lands on uneditable cards ([`cf50939`](https://github.com/Satcomx00-x00/SoloW/commit/cf50939e10d3ac0027aa8855a83cc08e7aca36fc))

## [0.17.2](https://github.com/Satcomx00-x00/SoloW/compare/v0.17.1...v0.17.2) — 2026-09-10

### Fixes

- **workflows:** Corroborate produced-changes for the branch, not only the gate — found by a branching control check ([`44f1f26`](https://github.com/Satcomx00-x00/SoloW/commit/44f1f269f09b83a6d7f16591fb860f87958d078d))

### Tests

- **e2e:** A control check that walks the product's main line on the host ([`c71c025`](https://github.com/Satcomx00-x00/SoloW/commit/c71c025ef35586318725b93b267e675d5907b0a7))

## [0.17.1](https://github.com/Satcomx00-x00/SoloW/compare/v0.17.0...v0.17.1) — 2026-09-10

### Fixes

- **dev:** Run next dev on webpack again, and let db:migrate find the dev key and database ([`d8d5376`](https://github.com/Satcomx00-x00/SoloW/commit/d8d5376fe9d9215658db178f6d6199586b4eb083))

## [0.17.0](https://github.com/Satcomx00-x00/SoloW/compare/v0.16.0...v0.17.0) — 2026-09-10

### Features

- **workflows:** A Workflow store, with its Skills fetched from the repositories that own them ([`15ec6e5`](https://github.com/Satcomx00-x00/SoloW/commit/15ec6e55db3a9f8f85be88f41e40027d2ae15b75))

## [0.16.0](https://github.com/Satcomx00-x00/SoloW/compare/v0.15.0...v0.16.0) — 2026-09-09

### Features

- **harness,workflows:** Never lose a harness session, and scope the terminal to one Step ([#156](https://github.com/Satcomx00-x00/SoloW/issues/156)) ([`ff93e57`](https://github.com/Satcomx00-x00/SoloW/commit/ff93e57beb7edfcd4335260d92db9a143ccb8068))

## [0.15.0](https://github.com/Satcomx00-x00/SoloW/compare/v0.14.2...v0.15.0) — 2026-09-08

### Features

- **status-bar,project:** Select and launch multiple issues, running tasks named and placed by their Issue ([`fab8b7c`](https://github.com/Satcomx00-x00/SoloW/commit/fab8b7c59d00aa61201fed9b6b29a5a1b37aad61))

### Fixes

- **ci:** Exclude bundled skill scripts from Biome, restore repository e2e selectors ([`1d7cc63`](https://github.com/Satcomx00-x00/SoloW/commit/1d7cc63e1b099487c25ba5d30cc1834fdde82171))
- **ci:** Regenerate openapi.json — stale against the recent-tasks preference procedures ([`6fa212d`](https://github.com/Satcomx00-x00/SoloW/commit/6fa212d8c30fae6c91e90fb2d9c374d4da769325))

## [0.14.2](https://github.com/Satcomx00-x00/SoloW/compare/v0.14.1...v0.14.2) — 2026-09-07

### Fixes

- **workflows:** A finished Task no longer holds its Workflow against deletion ([#155](https://github.com/Satcomx00-x00/SoloW/issues/155)) ([`833ad70`](https://github.com/Satcomx00-x00/SoloW/commit/833ad704ca06e8302acb70ef76f94b6eb9f56d9c))

## [0.14.1](https://github.com/Satcomx00-x00/SoloW/compare/v0.14.0...v0.14.1) — 2026-09-07

### Fixes

- **task:** Number a done Step instead of ticking it, and stop the sidebar repeating the header ([#154](https://github.com/Satcomx00-x00/SoloW/issues/154)) ([`a8cd1d1`](https://github.com/Satcomx00-x00/SoloW/commit/a8cd1d135db2d67f9cc569eba4ef4a40f8d27b93))

## [0.14.0](https://github.com/Satcomx00-x00/SoloW/compare/v0.13.2...v0.14.0) — 2026-09-07

### Features

- **board:** Colour the kanban columns, from the same seven state tokens everything else reads ([#153](https://github.com/Satcomx00-x00/SoloW/issues/153)) ([`0dc0117`](https://github.com/Satcomx00-x00/SoloW/commit/0dc01175361f62ace6355cf02567c5c58e147bdb))

## [0.13.2](https://github.com/Satcomx00-x00/SoloW/compare/v0.13.1...v0.13.2) — 2026-09-07

### Fixes

- **task:** Sidebar actions, coloured live Workflow steps, thinking toggle ([#152](https://github.com/Satcomx00-x00/SoloW/issues/152)) ([`4f2b973`](https://github.com/Satcomx00-x00/SoloW/commit/4f2b973351b5759a2704930ef0725bc202da0660))

## [0.13.1](https://github.com/Satcomx00-x00/SoloW/compare/v0.13.0...v0.13.1) — 2026-09-07

### Fixes

- **task:** Open shell commands, file changes and failures in the transcript by default ([#151](https://github.com/Satcomx00-x00/SoloW/issues/151)) ([`b0c13c2`](https://github.com/Satcomx00-x00/SoloW/commit/b0c13c2ca8e34afc2dcad6304c774bbb71929ba3))

## [0.13.0](https://github.com/Satcomx00-x00/SoloW/compare/v0.12.0...v0.13.0) — 2026-09-07

### Features

- **task:** Show the Workflow step in the runner, keep only the terminal, fit the launch dialog ([#150](https://github.com/Satcomx00-x00/SoloW/issues/150)) ([`e6687b8`](https://github.com/Satcomx00-x00/SoloW/commit/e6687b8173d22cc2743c96ec648beb7fad986140))

### Refactoring

- Rename "agent" to "harness" across UI, docs and internal code ([#149](https://github.com/Satcomx00-x00/SoloW/issues/149)) ([`c8b5f48`](https://github.com/Satcomx00-x00/SoloW/commit/c8b5f4818e8b83b14e5f5f1309192ff51c09c285))

## [0.12.0](https://github.com/Satcomx00-x00/SoloW/compare/v0.11.0...v0.12.0) — 2026-09-07

### Features

- **workflows:** A launch asks which Workflow first ([#148](https://github.com/Satcomx00-x00/SoloW/issues/148)) ([`70e931a`](https://github.com/Satcomx00-x00/SoloW/commit/70e931ae670ab0b7d30ae9a52dca7d5755372535))

## [0.11.0](https://github.com/Satcomx00-x00/SoloW/compare/v0.10.0...v0.11.0) — 2026-09-07

### Features

- **mcp:** Let a token build a Workflow — the authoring half of the namespace, with a guide ([#147](https://github.com/Satcomx00-x00/SoloW/issues/147)) ([`e484695`](https://github.com/Satcomx00-x00/SoloW/commit/e484695eb983fc51e7a520ec693fc6efe7156587))

## [0.10.0](https://github.com/Satcomx00-x00/SoloW/compare/v0.9.0...v0.10.0) — 2026-09-07

### Features

- **libraries:** An MCP store, Bearer-prefixed Secrets for remote endpoints, and default content ([#146](https://github.com/Satcomx00-x00/SoloW/issues/146)) ([`4f540c7`](https://github.com/Satcomx00-x00/SoloW/commit/4f540c7db922c50d0700e80c7767349edf4f82df))

## [0.9.0](https://github.com/Satcomx00-x00/SoloW/compare/v0.8.0...v0.9.0) — 2026-09-06

### Features

- **libraries:** MCP servers and Skills in one place, loaded per run and per Step ([#144](https://github.com/Satcomx00-x00/SoloW/issues/144)) ([`2985b8c`](https://github.com/Satcomx00-x00/SoloW/commit/2985b8c7a7ee4fb19953b8f4c4654f6c97eea489))

### Fixes

- **ci:** Keep the web app inside the executor boundary, and smoke the install the way it runs ([#145](https://github.com/Satcomx00-x00/SoloW/issues/145)) ([`b3e14a0`](https://github.com/Satcomx00-x00/SoloW/commit/b3e14a079651ff1b72624e4dbe19933d755156c5))

## [0.8.0](https://github.com/Satcomx00-x00/SoloW/compare/v0.7.0...v0.8.0) — 2026-09-06

### Features

- **workflows:** Run a Task through its Steps, on a node-graph designer with agent-decided branches ([#142](https://github.com/Satcomx00-x00/SoloW/issues/142)) ([`ba594e4`](https://github.com/Satcomx00-x00/SoloW/commit/ba594e49fc6f8ca5b6bca33ba7bdbaf29cc691a7))

## [0.7.0](https://github.com/Satcomx00-x00/SoloW/compare/v0.6.1...v0.7.0) — 2026-09-04

### Features

- **orchestrator:** Docker executor, with the mount guard its own docstring promised ([#141](https://github.com/Satcomx00-x00/SoloW/issues/141)) ([`1a6635b`](https://github.com/Satcomx00-x00/SoloW/commit/1a6635bc1dfb3256172287c188482b477a19e634))

## [0.6.1](https://github.com/Satcomx00-x00/SoloW/compare/v0.6.0...v0.6.1) — 2026-09-03

### Fixes

- **deps:** Close 14 advisories, without the two majors that would have shipped broken ([#140](https://github.com/Satcomx00-x00/SoloW/issues/140)) ([`aebad56`](https://github.com/Satcomx00-x00/SoloW/commit/aebad56cf3df091152ce94b8e520ea45d1855035))

## [0.6.0](https://github.com/Satcomx00-x00/SoloW/compare/v0.5.2...v0.6.0) — 2026-09-02

### Features

- **web:** Sync every linked repository now, from the status bar ([#139](https://github.com/Satcomx00-x00/SoloW/issues/139)) ([`9f69590`](https://github.com/Satcomx00-x00/SoloW/commit/9f6959004ebcfa63b07d2c618b0e658d9b9613e2))

## [0.5.2](https://github.com/Satcomx00-x00/SoloW/compare/v0.5.1...v0.5.2) — 2026-09-02

### Fixes

- **web:** Survive the network address, and stop asking the provider on every render ([#138](https://github.com/Satcomx00-x00/SoloW/issues/138)) ([`01318b6`](https://github.com/Satcomx00-x00/SoloW/commit/01318b628cbf7fc79370a58aedbe77b2ff6767fa))

## [0.5.1](https://github.com/Satcomx00-x00/SoloW/compare/v0.5.0...v0.5.1) — 2026-09-01

### Fixes

- **cli:** Ship the licence text the published package has never carried ([`5bada56`](https://github.com/Satcomx00-x00/SoloW/commit/5bada56597be71002125ec21ab909df084d3e8ae))

### Maintenance

- **licence:** Relicense from AGPL-3.0-only to Apache-2.0 ([`1a4c6e8`](https://github.com/Satcomx00-x00/SoloW/commit/1a4c6e855402944d37b18a4cd3ef7aafef00d606))

### Other

- Relicense to Apache-2.0, and ship the licence text the package never carried ([#137](https://github.com/Satcomx00-x00/SoloW/issues/137)) ([`ebcb813`](https://github.com/Satcomx00-x00/SoloW/commit/ebcb813f92850180e670f420e7c9ed0d3c10e55d))

## [0.5.0](https://github.com/Satcomx00-x00/SoloW/compare/v0.4.1...v0.5.0) — 2026-09-01

### Features

- **workspace:** A real workspace to set up, instead of a fixture pretending it was done ([`3d10ac6`](https://github.com/Satcomx00-x00/SoloW/commit/3d10ac600be0b9259cf80d304fc71ecbe194e5b6))
- **project:** Create Issues and Epics on the provider, and edit what GitLab holds ([`f59b568`](https://github.com/Satcomx00-x00/SoloW/commit/f59b5684ebea26e88ee4dd4330e05c889aa45a49))
- **scm,project:** Let a new GitHub Issue carry the fields GitHub actually has ([`ee4d99d`](https://github.com/Satcomx00-x00/SoloW/commit/ee4d99de77638586694b3727bd9deebf14c2b70a))
- **scm,project:** GitHub issue creation fields, unified parent-item dialog ([#130](https://github.com/Satcomx00-x00/SoloW/issues/130)) ([`f73cf3d`](https://github.com/Satcomx00-x00/SoloW/commit/f73cf3dd5087ba072df070fcf32256901c2a47af))
- **ci:** Cut the release from the merge that bumps the version ([`45101ce`](https://github.com/Satcomx00-x00/SoloW/commit/45101cec7c4072cd9d10e88cfcf3a84a4ba4f36c))
- **ci:** Let the commits decide the version, instead of a human remembering to ([`ebe558d`](https://github.com/Satcomx00-x00/SoloW/commit/ebe558d747ed971135ba0643a8532eea4c2e69ed))
- **ci:** Let the commits decide the version, instead of a human remembering to ([#135](https://github.com/Satcomx00-x00/SoloW/issues/135)) ([`48eb808`](https://github.com/Satcomx00-x00/SoloW/commit/48eb8086c09dc48de11bcb174973da31bd0d3e5b))

### Fixes

- **worktree:** A run the agent worktreed for itself could never be torn down ([`0c9f94b`](https://github.com/Satcomx00-x00/SoloW/commit/0c9f94b475154bd45702028aa927ba9ac247da76))
- **db:** `db:bootstrap` was renamed in one package.json but not the root ([`3b8ec24`](https://github.com/Satcomx00-x00/SoloW/commit/3b8ec24cc01631356b49a95a8dfbe4ada47a07c9))
- **mcp:** Every tool returning a list answered with an error instead of the list ([`7ca22d9`](https://github.com/Satcomx00-x00/SoloW/commit/7ca22d930580d0a37066d65c27d91154cc49e11f))
- **e2e:** Seed the Agent Profile and Executor the Task form requires ([`d0c8af4`](https://github.com/Satcomx00-x00/SoloW/commit/d0c8af422843ffcbfa44a0c49c4ab8f7cbc9bbd2))
- **e2e:** Seed the Agent Profile and Executor the Task form requires ([#131](https://github.com/Satcomx00-x00/SoloW/issues/131)) ([`46b9f10`](https://github.com/Satcomx00-x00/SoloW/commit/46b9f1034631edcf99cd807691c1352fdc645561))
- **orchestrator:** Stop waiting on pipes a killed command left behind ([`cd6f62f`](https://github.com/Satcomx00-x00/SoloW/commit/cd6f62f41b7f28e1b5c86958edf9bf300619ec43))
- **orchestrator:** Stop waiting on pipes a killed command left behind ([#133](https://github.com/Satcomx00-x00/SoloW/issues/133)) ([`0893460`](https://github.com/Satcomx00-x00/SoloW/commit/0893460032ca127c6dd509714feaf7dbb7f3e1b7))

### Performance

- **scm:** Revalidate instead of re-download, and read a listing's pages at once ([`43d4c94`](https://github.com/Satcomx00-x00/SoloW/commit/43d4c94043922064aff112b55558223616d83d71))
- **web:** Stop reloading what the browser is already holding ([`bd0dbb3`](https://github.com/Satcomx00-x00/SoloW/commit/bd0dbb3528020e99ce4bd61a18e11f5ca5a3119e))
- **scm,web:** Revalidate provider reads, and stop reloading what the client holds ([#134](https://github.com/Satcomx00-x00/SoloW/issues/134)) ([`4487f26`](https://github.com/Satcomx00-x00/SoloW/commit/4487f26f98cc3eb62dc71d96d424b1d7886a14a8))

### Documentation

- **decisions:** Record why provider reads revalidate rather than expire ([`2d22c10`](https://github.com/Satcomx00-x00/SoloW/commit/2d22c10cc1fb83534b98f262d664f5b796227062))
- **decisions:** Record that the commits now decide the version ([`772e0ab`](https://github.com/Satcomx00-x00/SoloW/commit/772e0abe979aca06030951f9cff377810ca108e1))

### Tests

- **scm,project:** Cover the gaps F23a left, and make the manifest refinement real ([`d82fbc4`](https://github.com/Satcomx00-x00/SoloW/commit/d82fbc492dfac3e56f4bae907d3b1a545747b380))

### Maintenance

- Save ([`db769ec`](https://github.com/Satcomx00-x00/SoloW/commit/db769ec0c543e96ab8c315f00be91380509b2218))
- **repo:** Stop tracking one machine's local state ([`32aa869`](https://github.com/Satcomx00-x00/SoloW/commit/32aa869ab49dd92563659caa92443610c4eb4a5b))

## [0.4.1](https://github.com/Satcomx00-x00/SoloW/compare/v0.4.0...v0.4.1) — 2026-08-28

### Features

- **agents:** Integrate opencode — a catalog row, not an adapter ([`3835d3d`](https://github.com/Satcomx00-x00/SoloW/commit/3835d3dcd652dadc06e712572e8eaf99779fc95e))
- **agents:** Make the Profile form honest about what each agent can be told ([`fa52b6d`](https://github.com/Satcomx00-x00/SoloW/commit/fa52b6ddedc2ddd534f6f2b57929dec779118923))
- **agents:** Ask an agent whether it works, before a Task finds out ([`a49ffd6`](https://github.com/Satcomx00-x00/SoloW/commit/a49ffd6230c6bd25edc80308eb708ae9d90cc390))

### Fixes

- **cli:** 0.4.1 ([`1ea2fa8`](https://github.com/Satcomx00-x00/SoloW/commit/1ea2fa843682fe97e34a4577c92c5db4ed449486))

### Refactoring

- **agents:** One description per protocol, and a driver for every one ([`0ac63a5`](https://github.com/Satcomx00-x00/SoloW/commit/0ac63a55d8789eb4154d650172f7bb3d0b550b54))

### Build and CI

- **release:** Install the tarball and run it, before publishing it ([`0e5b69b`](https://github.com/Satcomx00-x00/SoloW/commit/0e5b69bc4926e3ffabb4acc1221488cc71efcccf))

## [0.4.0](https://github.com/Satcomx00-x00/SoloW/compare/v0.3.1...v0.4.0) — 2026-08-28

### Features

- **cli:** Ship the Inngest binary in npm packages, so an airgap install works ([`c3a1fe3`](https://github.com/Satcomx00-x00/SoloW/commit/c3a1fe3686a5a4ffeff29d3f83d6767f47d5bc8b))

## [0.3.1](https://github.com/Satcomx00-x00/SoloW/compare/v0.3.0...v0.3.1) — 2026-08-28

### Fixes

- **cli:** Take Bun from its @oven npm package, so an airgapped install works ([`b1002f6`](https://github.com/Satcomx00-x00/SoloW/commit/b1002f688c76c05d3970c0914494352a0fe4f03a))

## [0.3.0](https://github.com/Satcomx00-x00/SoloW/compare/v0.2.2...v0.3.0) — 2026-08-28

### ⚠ Breaking changes

- **cli:** Never download binaries on start; use an inngest from PATH ([`f04f011`](https://github.com/Satcomx00-x00/SoloW/commit/f04f011d81d4de9f667d4e485467120bcf17498d))
on a machine whose npm skips install scripts, `npx` no
longer downloads the missing binaries silently. Install `inngest-cli` and
Bun once, or set SOLOW_FETCH_BINARIES=1.

### Features

- **cli:** Never download binaries on start; use an inngest from PATH ([`f04f011`](https://github.com/Satcomx00-x00/SoloW/commit/f04f011d81d4de9f667d4e485467120bcf17498d))

## [0.2.2](https://github.com/Satcomx00-x00/SoloW/compare/v0.2.1...v0.2.2) — 2026-08-28

### Fixes

- **cli:** Fetch bun and inngest binaries when npm skips their install hooks ([`84d51ae`](https://github.com/Satcomx00-x00/SoloW/commit/84d51ae6d2f8ad66c6991476ceef8ad5cf186b4b))

## [0.2.1](https://github.com/Satcomx00-x00/SoloW/compare/v0.2.0...v0.2.1) — 2026-08-28

### Fixes

- **cli:** Flatten node_modules so the published package can resolve next ([`a667b2e`](https://github.com/Satcomx00-x00/SoloW/commit/a667b2eef851acf2159562f80ab35ffcc47e852a))

## [0.2.0](https://github.com/Satcomx00-x00/SoloW/compare/v0.1.4...v0.2.0) — 2026-08-28

### Features

- **project:** A local Project declares GitHub's exact column set ([`fd63961`](https://github.com/Satcomx00-x00/SoloW/commit/fd639617737ce29da4923c4e2cd4b353fe232642))

## [0.1.4](https://github.com/Satcomx00-x00/SoloW/compare/v0.1.3...v0.1.4) — 2026-08-28

### Fixes

- **cli:** Scope the package to @satcomx00-x00/solow ([`d0a1d22`](https://github.com/Satcomx00-x00/SoloW/commit/d0a1d224ebcbe1d94418a8dc8da4dcce28a1199c))

## [0.1.3](https://github.com/Satcomx00-x00/SoloW/compare/v0.1.2...v0.1.3) — 2026-08-27

### Fixes

- **build:** Trust bun's own postinstall so the CLI package can bundle it ([`af01a22`](https://github.com/Satcomx00-x00/SoloW/commit/af01a22e5ec75191bf2d8f54aff5b423b69b23c7))

## [0.1.2](https://github.com/Satcomx00-x00/SoloW/compare/v0.1.1...v0.1.2) — 2026-08-27

### Fixes

- **web:** Index.test.ts relied on SOLOW_DEV_OWNER leaking from another file ([`7a7f6df`](https://github.com/Satcomx00-x00/SoloW/commit/7a7f6dfdc57dd95675e1b1d849b9fb7122933c8e))

## [0.1.1](https://github.com/Satcomx00-x00/SoloW/compare/v0.1.0...v0.1.1) — 2026-08-27

### Fixes

- **core,web:** Two leftover @gatecontrol/contracts imports from the rename ([`4be6ebf`](https://github.com/Satcomx00-x00/SoloW/commit/4be6ebf06c93641bf82d93d4ca2e72545b1e5497))

## [0.1.0](https://github.com/Satcomx00-x00/SoloW/compare/v0.0.1...v0.1.0) — 2026-08-27

### Features

- **project:** Local Project field synthesis, GitLab sync fixes, delete Project ([`1bad1da`](https://github.com/Satcomx00-x00/SoloW/commit/1bad1da70b37c7fe9e986ba31379e0aef55116fe))

## [0.0.1](https://github.com/Satcomx00-x00/SoloW/releases/tag/v0.0.1) — 2026-08-27

### ⚠ Breaking changes

- Rename GateControl to SoloW ([`2e1ac84`](https://github.com/Satcomx00-x00/SoloW/commit/2e1ac847fc375a11064cafbf290d1c923bc5c4f6))
every GATECONTROL_* environment variable is now SOLOW_*, and
the local data directory moved from .gatecontrol/ to .solow/. An existing
install needs both renamed — the database file is unchanged otherwise.

### Features

- **core-program:** Verified backend (Phase 1–2) + specs, docs, constitution ([`577d97c`](https://github.com/Satcomx00-x00/SoloW/commit/577d97c082d3ab3d7deca92acc18769a688b1bd2))
- **core-program:** Orchestrator (Phase 3) + shared core package — verified ([`8ac65d2`](https://github.com/Satcomx00-x00/SoloW/commit/8ac65d29fb3823d8d256cd0f495b4e9baa7b6895))
- **core-program:** Backend completion — seed, rate-limit, OpenAPI, orchestrator + observability tests; adopt Biome ([`198ddfe`](https://github.com/Satcomx00-x00/SoloW/commit/198ddfe06a3dcfea4d5c57ca648819a5f403acea))
- **core-program:** Phase 4 vertical slice — Next.js SPA + live Kanban board (TASK-021 partial) ([`64dde08`](https://github.com/Satcomx00-x00/SoloW/commit/64dde0851d4bae73febbf6d65ba265fc108b0bc5))
- **core-program:** Phase 4 settings + board tests (TASK-023, TASK-024 partial) ([`3d04c9d`](https://github.com/Satcomx00-x00/SoloW/commit/3d04c9d284ca88668fb0c1637707a2e2b06e740e))
- **web:** Task workspace (IDE-style review view) + session read API ([`a15acd1`](https://github.com/Satcomx00-x00/SoloW/commit/a15acd1d26258ff6c20732b8999e7cd1d70a8bc0))
- **web:** VS Code-style status bar ([`76654dd`](https://github.com/Satcomx00-x00/SoloW/commit/76654dddcc0615d7f5d263105d2a8b15ff63538f))
- **web:** Drag-and-drop board (dnd-kit) ([`11c8a2d`](https://github.com/Satcomx00-x00/SoloW/commit/11c8a2d57cd26266faeb83c9179719caf0e1759e))
- **orchestrator:** A single Executor interface before the second kind exists ([`345aae2`](https://github.com/Satcomx00-x00/SoloW/commit/345aae2335a6c5111ad0d887e5ad74cbae918335))
- **usage:** Capture per-turn token usage — closes [#14](https://github.com/Satcomx00-x00/SoloW/issues/14) ([`40dba1e`](https://github.com/Satcomx00-x00/SoloW/commit/40dba1e8133d3cd815e2030e8167afbf98c7ce4f))
- **usage:** Per-turn token usage capture ([#14](https://github.com/Satcomx00-x00/SoloW/issues/14)), and repair main's broken smoke test ([#112](https://github.com/Satcomx00-x00/SoloW/issues/112)) ([`5355a0e`](https://github.com/Satcomx00-x00/SoloW/commit/5355a0e1829894ca2110b509a65df9ccfc9402fc))
- **integrations:** GitHub/GitLab issue, branch, and change-request sync — closes [#15](https://github.com/Satcomx00-x00/SoloW/issues/15) ([`1fac7c3`](https://github.com/Satcomx00-x00/SoloW/commit/1fac7c36d05289296c41ea318cf76dde1f904950))
- **executors:** Typed per-kind Executor Profile configuration — closes [#73](https://github.com/Satcomx00-x00/SoloW/issues/73) ([`4f1b313`](https://github.com/Satcomx00-x00/SoloW/commit/4f1b313341f315ea51129c7a4390c52445fa86ba))
- **executors:** Typed per-kind Executor Profile configuration — closes [#73](https://github.com/Satcomx00-x00/SoloW/issues/73) ([#113](https://github.com/Satcomx00-x00/SoloW/issues/113)) ([`5bafd18`](https://github.com/Satcomx00-x00/SoloW/commit/5bafd18522f1046ee3fb95afe42c25dc3fbefc04))
- **agents:** Agent catalog replaces the agentKind enum — closes [#10](https://github.com/Satcomx00-x00/SoloW/issues/10) ([`8eea85d`](https://github.com/Satcomx00-x00/SoloW/commit/8eea85da0e6a6db24ab9d5f803d53a8fdaba6569))
- **agents:** Agent catalog replaces the agentKind enum — closes [#10](https://github.com/Satcomx00-x00/SoloW/issues/10) ([#114](https://github.com/Satcomx00-x00/SoloW/issues/114)) ([`57fcafa`](https://github.com/Satcomx00-x00/SoloW/commit/57fcafa7ff05432b6a80378cc4919b7bfd45fc4a))
- **integrations:** GitHub/GitLab issue, branch, and change-request sync — closes [#15](https://github.com/Satcomx00-x00/SoloW/issues/15) ([#116](https://github.com/Satcomx00-x00/SoloW/issues/116)) ([`eb2009f`](https://github.com/Satcomx00-x00/SoloW/commit/eb2009fe6c7b2b0e41bab16aa4c938805858b4b2))
- **mcp:** External MCP server derived from the tRPC contracts — closes [#16](https://github.com/Satcomx00-x00/SoloW/issues/16) ([`845993a`](https://github.com/Satcomx00-x00/SoloW/commit/845993a8829f4edb47254cce39c9ee8e46c3def9))
- **mcp:** External MCP server derived from the tRPC contracts — closes [#16](https://github.com/Satcomx00-x00/SoloW/issues/16) ([#118](https://github.com/Satcomx00-x00/SoloW/issues/118)) ([`c804899`](https://github.com/Satcomx00-x00/SoloW/commit/c80489958c63da95cd8e514d8e5eda7543677623))
- **integrations:** Pick a real repository when linking, instead of typing owner/repo ([`18bbc84`](https://github.com/Satcomx00-x00/SoloW/commit/18bbc84bd35e0c0a77d362578c1c4aa54c37eb7e))
- **repos:** Copy allowlisted setup files into new worktrees — closes [#74](https://github.com/Satcomx00-x00/SoloW/issues/74) ([`4769a8f`](https://github.com/Satcomx00-x00/SoloW/commit/4769a8f3001a262cb0f94ace36994aae839f6c3a))
- **orchestration:** Task dependencies as blocked_by edges with cycle detection — closes [#6](https://github.com/Satcomx00-x00/SoloW/issues/6) ([`14f24ba`](https://github.com/Satcomx00-x00/SoloW/commit/14f24baf157e41643dd9acf84c0175c5ff959be0))
- **platform:** Contribution registries for commands, status items and notification channels — closes [#3](https://github.com/Satcomx00-x00/SoloW/issues/3) ([`12be9ac`](https://github.com/Satcomx00-x00/SoloW/commit/12be9ac43ec59b82a12a439fa4ac01d100017ae1))
- **agents:** A real ACP client, with Claude Code as one adapter behind it — closes [#58](https://github.com/Satcomx00-x00/SoloW/issues/58) ([`059aa48`](https://github.com/Satcomx00-x00/SoloW/commit/059aa485134dde7d9f461ddca1182ebc109dd690))
- **orchestration:** Multi-repository tasks and a typed, compacting session log — closes [#7](https://github.com/Satcomx00-x00/SoloW/issues/7), closes [#2](https://github.com/Satcomx00-x00/SoloW/issues/2) ([`b83378d`](https://github.com/Satcomx00-x00/SoloW/commit/b83378d5a104812724e3885286a42b69b63bc2f3))
- **workflows:** The workflow and workflow_step tables — foundation for issue [#5](https://github.com/Satcomx00-x00/SoloW/issues/5), not closing it ([`d0a9e40`](https://github.com/Satcomx00-x00/SoloW/commit/d0a9e405ade2788b1feb9f69b82e5a745c620234))
- **task:** A readable transcript, lifecycle controls and an agent plan ([`4b43f38`](https://github.com/Satcomx00-x00/SoloW/commit/4b43f3830107499f0b905459eb7cf9f3259460b3))
- **integrations:** Providers register their capabilities — Gitea is the proof ([`9e0a961`](https://github.com/Satcomx00-x00/SoloW/commit/9e0a961aaf2a02a1c640b8d1dfbdea2582d959f9))
- **lifecycle:** A run that finished says so, before the part that can be lost ([`4c826ef`](https://github.com/Satcomx00-x00/SoloW/commit/4c826efea0a259ee78194da22c2f3efc90094f4b))
- **cli:** Publish as `solow`, runnable with npx ([`eafebcf`](https://github.com/Satcomx00-x00/SoloW/commit/eafebcf93c048005a4692ed326a1840bdd956d88))

### Fixes

- **core:** Add bun-types so packages/core typechecks its bun:test files ([`e081c8c`](https://github.com/Satcomx00-x00/SoloW/commit/e081c8cee25752c9fb944cf31634375c1086e2cf))
- **ci:** Grant contents:read to the label sync workflow ([`a5f2256`](https://github.com/Satcomx00-x00/SoloW/commit/a5f2256765e23854dd1097e215050b7f20862606))
- Drop the stray .claude/worktrees gitlink ([`acaf73c`](https://github.com/Satcomx00-x00/SoloW/commit/acaf73c35f27e7523548576023da42a3f52d31ba))
- Handle the resume round's absent worktree name ([`0a7ccc6`](https://github.com/Satcomx00-x00/SoloW/commit/0a7ccc6e55f27ff1bb89f065c42a6aad3b7d405c))
- Repair scripts/smoke.ts against the Executor signatures ([`49698de`](https://github.com/Satcomx00-x00/SoloW/commit/49698de9894e08003fa2e020f3aa7aa747e9d1d4))
- **usage:** Continue turn numbering across review rounds ([`1b7d419`](https://github.com/Satcomx00-x00/SoloW/commit/1b7d419666badc2084c92e6de77de778d943a679))
- **usage:** Key usage on the turn, not the stream event ([`4a01ab2`](https://github.com/Satcomx00-x00/SoloW/commit/4a01ab238c4c0946a0ffb4d251f4e81f6cf3e3a1))
- **usage:** Make the coverage gap reachable, and harden cost lookup ([`6876be4`](https://github.com/Satcomx00-x00/SoloW/commit/6876be420eca3df1aa075eea369bf1598dab8043))
- Handle the resume round's absent worktree name, with tests ([`4ce53fb`](https://github.com/Satcomx00-x00/SoloW/commit/4ce53fbc5fa426207b4ba221018f51f0ea96165e))
- **integrations:** Scope Issue/ChangeRequest identity to Repository, not Integration ([`77d8616`](https://github.com/Satcomx00-x00/SoloW/commit/77d86160e58965ea3ae1c46c7ddb236f0fd59285))
- **e2e:** Thread agentCatalogId through seed-cli's task fixture ([`72aaeea`](https://github.com/Satcomx00-x00/SoloW/commit/72aaeeacef39cb67e1281b597e6308068eeed808))
- Migrate ([`c48c539`](https://github.com/Satcomx00-x00/SoloW/commit/c48c5392d2864e22db4fa746fff5688a108fa2a1))
- **live:** A Task's own page never heard its Task change state ([`d285b5d`](https://github.com/Satcomx00-x00/SoloW/commit/d285b5d120ee02f4535af5e355ba7fb5e5401fe2))

### Refactoring

- **web:** Conventional, accessible forms ([`101200f`](https://github.com/Satcomx00-x00/SoloW/commit/101200ff51abb45ff7336da386511d67490c74b8))
- Rename GateControl to SoloW ([`2e1ac84`](https://github.com/Satcomx00-x00/SoloW/commit/2e1ac847fc375a11064cafbf290d1c923bc5c4f6))

### Documentation

- **product:** Row-by-row feature comparison of the current build vs kandev ([`3861131`](https://github.com/Satcomx00-x00/SoloW/commit/386113197e77536f837684bb6d64cce66a49c93d))
- **product:** Add best-implementation and UI-shape columns to the kandev comparison ([`b1c0804`](https://github.com/Satcomx00-x00/SoloW/commit/b1c080427b96e53bf9d0f76ffba05c56174e3637))
- Narrow the integration surface to GitHub and GitLab ([`2f1cf77`](https://github.com/Satcomx00-x00/SoloW/commit/2f1cf770aebfe8c1384a3c35ad667fa48fe9be2b))
- **integrations:** A capability registry for providers — decision 0016, feature F21 ([`3e44e81`](https://github.com/Satcomx00-x00/SoloW/commit/3e44e816d96430bf737c10627c544928ceef83ef))

### Tests

- Give the E2E suite a CI-sized timeout budget ([`4dd8725`](https://github.com/Satcomx00-x00/SoloW/commit/4dd8725416d160a2d97d60680e2541f8e5d6eb1e))

### Build and CI

- **core-program:** Makefile + unit tests + end-to-end smoke test (verified) ([`125bfd0`](https://github.com/Satcomx00-x00/SoloW/commit/125bfd0dde68cc6a8d78b5e3552143ecc105aa13))
- **dev:** Add `bun run dev` with hot reload; default orchestrator port 5000 ([`7ed3fc8`](https://github.com/Satcomx00-x00/SoloW/commit/7ed3fc8d20aa230520b0f2104feae59289a125f3))
- Enforce the quality gates, and add milestones-as-code ([`c0108e3`](https://github.com/Satcomx00-x00/SoloW/commit/c0108e3923f6a28c5db213a793b9fd2f11fa0ae3))
- Gate the smoke test and the executor-boundary audit ([`c9fa93e`](https://github.com/Satcomx00-x00/SoloW/commit/c9fa93e6faa5509bfa32112169248f334bcce19f))
- Stop `playwright install --with-deps` hanging E2E for 30 minutes ([`c3b36c3`](https://github.com/Satcomx00-x00/SoloW/commit/c3b36c39f188d5fd2defb87a0f84ad4764488e01))
- Stop playwright install --with-deps hanging E2E for 30 minutes ([#115](https://github.com/Satcomx00-x00/SoloW/issues/115)) ([`fed0043`](https://github.com/Satcomx00-x00/SoloW/commit/fed004331a063e8aa5ae99dc7bce51f8c99985d1))

### Maintenance

- Init ([`2ef0c31`](https://github.com/Satcomx00-x00/SoloW/commit/2ef0c31e2c16c053402371a03ab75f17136add3e))
- Init ([`57d971c`](https://github.com/Satcomx00-x00/SoloW/commit/57d971ce63dd255b8ba2c1835e0ab9c3eca7e456))
- Init ([`0aff724`](https://github.com/Satcomx00-x00/SoloW/commit/0aff7248b0e480b36c562147bdf5ab680b843c8c))
- Init ([`c9dbe45`](https://github.com/Satcomx00-x00/SoloW/commit/c9dbe45f7871ecb30553cea3cf32235b7113a59e))
- **backlog:** Label taxonomy script and issue-tracker cross-references ([`b2d5686`](https://github.com/Satcomx00-x00/SoloW/commit/b2d56862d7270856aff8fe922750978bbff41a88))
- **labels:** Labels-as-code manifest with a colour palette, applied by CI ([`6e200b7`](https://github.com/Satcomx00-x00/SoloW/commit/6e200b725bcfcf8abb61c466b82748dbf79f38d4))
- Format the label manifest to Biome's rules ([`a874524`](https://github.com/Satcomx00-x00/SoloW/commit/a874524d15c2029c5324252f96377cabbe1f77a7))
- Import repos ([`e59d93d`](https://github.com/Satcomx00-x00/SoloW/commit/e59d93d9677d01072052c0544aad43dd69ca477a))
- Save ([`6ef85b4`](https://github.com/Satcomx00-x00/SoloW/commit/6ef85b4ed825a2ff0fc91d30c9ab713328f1a0aa))
- Save ([`e1e7079`](https://github.com/Satcomx00-x00/SoloW/commit/e1e7079f100b4f27ddb2bb507fe9fd83595d3110))
- Save ([`4aad93a`](https://github.com/Satcomx00-x00/SoloW/commit/4aad93abb17085ae06c25a9bcb33717a2b12f04d))

### Other

- Initial commit ([`6486dca`](https://github.com/Satcomx00-x00/SoloW/commit/6486dca34dae9a97f09ec222974f7f09e5b8ff03))
- Initial import onto main: the 001-core-program build, a kandev parity backlog, and CI that enforces the quality gates ([#110](https://github.com/Satcomx00-x00/SoloW/issues/110)) ([`1d4861d`](https://github.com/Satcomx00-x00/SoloW/commit/1d4861d49e029fc41b183e8fd39933d9cf2eb9b4))
- A single Executor interface, before the second executor kind exists ([#111](https://github.com/Satcomx00-x00/SoloW/issues/111)) ([`fcc4236`](https://github.com/Satcomx00-x00/SoloW/commit/fcc4236c416cfa08f9a77a4b8745285259449909))
- 001-core-program resume-round worktree fix into main ([`b63ea69`](https://github.com/Satcomx00-x00/SoloW/commit/b63ea6935da2442210847cfc32ad9e7003c0634a))

