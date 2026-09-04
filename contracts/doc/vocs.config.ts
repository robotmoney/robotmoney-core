import { defineConfig } from 'vocs/config'
import { sidebar } from './vocs.sidebar'

export default defineConfig({
  title: "Documentation",
  editLink: { pattern: 'https://github.com/robotmoney/robotmoney-core/edit/dev/{path}' },
  codeHighlight: {
    fallbackLanguage: 'plaintext',
    langs: [
      'ansi', 'bash', 'diff', 'html', 'js', 'json', 'jsx',
      'markdown', 'md', 'mdx', 'plaintext', 'rust', 'sol', 'solidity',
      'toml', 'ts', 'tsx', 'yaml', 'zsh',
    ],
  },
  sidebar,
})
