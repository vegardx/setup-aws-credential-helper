export default {
  branches: ["main"],
  tagFormat: "v${version}",
  plugins: [
    ["@semantic-release/commit-analyzer", { preset: "conventionalcommits" }],
    [
      "@semantic-release/release-notes-generator",
      { preset: "conventionalcommits" },
    ],
    [
      "@semantic-release/github",
      {
        successComment: false,
        failTitle: false,
        labels: false,
      },
    ],
    [
      "@semantic-release/exec",
      {
        successCmd:
          'echo "new-release-published=true" >> "$GITHUB_OUTPUT" && echo "new-release-version=${nextRelease.version}" >> "$GITHUB_OUTPUT"',
      },
    ],
  ],
};
