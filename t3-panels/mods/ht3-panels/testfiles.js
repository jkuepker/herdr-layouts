// Which changed files the Diff's "Hide test files" toggle leaves out. Pure: a path in, a boolean out.
// Ported from T3 Code's isTestChangedFile (packages/shared/src/changedFileKind.ts), which hides what it classifies
// as "tests" or "mocks" and not "generated". It is wider than the plain rule (*.test.*, *.spec.*, *_test.go,
// test_*.py, *_test.py, and a test/tests/spec/__tests__/__mocks__ directory): it also takes .e2e./.eval. files,
// conftest.py, jest/vitest setup files, Java-style FooTest.java, snapshots, fixtures, mocks and stubs, and the
// directories cypress, e2e, evals, specs, __test__, __fixtures__, __snapshots__, fixtures, mocks, stubs, testdata.
// A generated file (a lockfile, *.generated.*, a generated/ directory) is never a test, as in T3.

const GENERATED_FILES = new Set(["bun.lock", "bun.lockb", "cargo.lock", "composer.lock", "deno.lock", "flake.lock", "gemfile.lock", "go.sum",
  "gradle.lockfile", "mix.lock", "npm-shrinkwrap.json", "package-lock.json", "packages.lock.json", "pipfile.lock", "pnpm-lock.yaml",
  "podfile.lock", "poetry.lock", "pubspec.lock", "uv.lock", "yarn.lock"]);
const GENERATED_NAME = /(\.generated\.|\.gen\.|\.g\.dart$|\.pb\.go$|_pb2(_grpc)?\.py$|\.pb\.(cc|h)$|\.min\.(js|css)$|\.(js|css)\.map$)/;
const GENERATED_DIRS = new Set(["__generated__", "_generated", "generated"]);
const MOCK_NAME = /(\.snap$|\.(mocks?|fixtures?|stubs?|fakes?)\.[^.]+$|^(mocks?|fixtures?|stubs?|fakes?)([-_.A-Z]|$))/;
const MOCK_DIRS = new Set(["__fixtures__", "__mocks__", "__snapshots__", "fakes", "fixture", "fixtures", "mock", "mocks", "stubs", "testdata"]);
const TEST_NAME = /(\.(test|spec|e2e|eval)\.[^.]+$|_(test|spec)\.[^.]+$|^test_.+\.py$|^conftest\.py$|^(vitest|jest)\.setup\.[^.]+$)/i;
// Case-sensitive: FooTest.java is a test class, Latest.java is not.
const CLASS_TEST_NAME = /(Tests?|Spec)\.(java|kt|kts|scala|groovy|cs|php|swift|m)$/;
const TEST_DIRS = new Set(["__tests__", "__test__", "cypress", "e2e", "evals", "spec", "specs", "test", "tests"]);

export function isTestFile(path) {
  const segments = String(path ?? "").replaceAll("\\", "/").split("/");
  const name = segments.pop() ?? "";
  const dirs = segments.map((s) => s.toLowerCase());
  const inDir = (set) => dirs.some((d) => set.has(d));
  if (GENERATED_FILES.has(name.toLowerCase()) || GENERATED_NAME.test(name) || inDir(GENERATED_DIRS)) return false;
  return MOCK_NAME.test(name) || inDir(MOCK_DIRS) || TEST_NAME.test(name) || CLASS_TEST_NAME.test(name) || inDir(TEST_DIRS);
}
