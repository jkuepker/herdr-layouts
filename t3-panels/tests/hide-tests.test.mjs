// node t3-panels/tests/hide-tests.test.mjs
// isTestFile (testfiles.js): which paths the Diff's Hide test files toggle leaves out.
import assert from "node:assert/strict";
import { isTestFile } from "../mods/ht3-panels/testfiles.js";

for (const p of ["a.test.js", "src/a.spec.ts", "pkg/foo_test.go", "tests_x/test_foo.py", "foo_test.py", "src/__tests__/a.js", "test/a.js", "a/tests/b/c.rs",
  "spec/a.rb", "src/__mocks__/x.js", "src/Foo.test.tsx", "win\\tests\\a.js", "src/FooTest.java", "a/__snapshots__/x.snap", "conftest.py"]) assert.equal(isTestFile(p), true, p);
for (const p of ["src/app.js", "latest.js", "src/testing.js", "contest.js", "src/Latest.java", "protests/a.js", "package-lock.json", "a/generated/x.test.js", "x.generated.test.ts", "README.md", "", "test.js", "src/testutil/a.js"]) assert.equal(isTestFile(p), false, p);
assert.equal(isTestFile(undefined), false);
console.log("hide-tests: ok");
