import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useAppStore = defineStore('app', () => {
  const isDarkTheme = ref(localStorage.getItem('theme') === 'dark')

  function toggleTheme() {
    isDarkTheme.value = !isDarkTheme.value
    localStorage.setItem('theme', isDarkTheme.value ? 'dark' : 'light')
    updateThemeClass()
  }

  function updateThemeClass() {
    // 类名过去是反的：light-theme 里装的是深色值，导致默认（浅色）渲染成深色。
    // 现在浅色挂 light-theme、深色挂 dark-theme，与 prototype.css 的取值一致。
    document.body.classList.toggle('light-theme', !isDarkTheme.value)
    document.body.classList.toggle('dark-theme', isDarkTheme.value)
  }

  updateThemeClass()

  return {
    isDarkTheme,
    toggleTheme,
  }
})
