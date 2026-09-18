const fs = require("fs");
const path = require("path");
const {
  spawnSync
} = require("child_process");

const root =
  path.join(
    __dirname,
    ".."
  );

const files = [
  "server.js",
  "worker.js",
  "db.js"
];

for (
  const dir of [
    "lib",
    "routes",
    "scripts",
    "tests"
  ]
) {
  const fullDir =
    path.join(
      root,
      dir
    );

  for (
    const name of
    fs.readdirSync(fullDir)
  ) {
    if (
      !name.endsWith(".js") ||
      name.includes("-before-")
    ) {
      continue;
    }

    files.push(
      path.join(
        dir,
        name
      )
    );
  }
}

let failed = false;

for (const file of files) {
  const result =
    spawnSync(
      process.execPath,
      [
        "--check",
        path.join(
          root,
          file
        )
      ],
      {
        stdio: "inherit"
      }
    );

  if (result.status !== 0) {
    failed = true;
  }
}

if (failed) {
  process.exit(1);
}

console.log(
  `Syntax check passed: ${files.length} file(s).`
);
