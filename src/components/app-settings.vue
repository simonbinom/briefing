<script lang="ts">
import { isAllowedBugTracking, setAllowedBugTracking } from '../bugs'
import { ICE_CONFIG, RELEASE, SIGNAL_SERVER_URL } from '../config'
import { t } from '../i18n'
import { messages } from '../lib/messages'
import { WebRTC } from '../logic/webrtc'
import { state } from '../state'

export default {
  name: 'AppSettings',
  data() {
    return {
      enableSubscribe: false,
      iOS: window.iOS,
      iPhone: window.iPhone,
      SIGNAL_SERVER_URL,
      ICE_CONFIG,
      signalStatus: '',
      showInfo: false,
      state,
    }
  },
  computed: {
    release: _ => RELEASE,
    sentry: {
      set(v) {
        setAllowedBugTracking(v, t('settings.sentry_confirm'))
      },
      get() {
        return isAllowedBugTracking()
      },
    },
    video() {
      const videoDevices = state.devices.filter(
        d => d.kind === 'videoinput' && d.deviceId !== 'default',
      )
      if (navigator?.mediaDevices?.getDisplayMedia) {
        return [
          {
            deviceId: 'desktop',
            label: `${t('settings.desktop')}\xA0 🖥`,
          },
          ...videoDevices,
        ]
      }
      return videoDevices
    },
    audio() {
      return state.devices.filter(
        d => d.kind === 'audioinput' && d.deviceId !== 'default',
      )
    },
  },
  watch: {
    'state.deviceVideo': async function () {
      await this.$nextTick()
      messages.emit('switchMedia')
    },
    'state.deviceAudio': async function () {
      await this.$nextTick()
      messages.emit('switchMedia')
    },
    'state.backgroundMode': async function (value, prevValue) {
      await this.$nextTick()
      if ((value && !prevValue) || (prevValue && !value)) {
        // Toggling on/off: full stream restart
        messages.emit('switchMedia')
      }
      else if (value && prevValue) {
        // Switching between blur <-> image: just update options
        messages.emit('updateBackgroundMode')
      }
    },
    'state.bandwidth': async function () {
      await this.$nextTick()
      messages.emit('negotiateBandwidth')
    },
    'state.subscribe': async function () {
      await this.$nextTick()
      messages.emit('subscribePush')
    },
  },
  mounted() {
    // this.doCheckSignal()
  },
  methods: {
    async doCheckSignal() {
      const result = await WebRTC.checkStatus() as any
      this.signalStatus = result.ok ? '✅' : '❌'
    },
    onBackgroundImageUpload(event: Event) {
      const input = event.target as HTMLInputElement
      const file = input?.files?.[0]
      if (!file)
        return
      const reader = new FileReader()
      reader.onload = (e) => {
        const dataURL = e.target?.result as string
        state.backgroundImageURL = dataURL
        try {
          localStorage.setItem('backgroundImageURL', dataURL)
        }
        catch (err) { /* storage full */ }
        if (state.backgroundMode === 'image')
          messages.emit('updateBackgroundMode')
      }
      reader.readAsDataURL(file)
    },
  },
}
</script>

<template>
  <div class="text">
    <div v-if="video.length" class="form-group settings-group">
      <label class="form-labelx"><b>{{ $t('settings.video') }}</b></label>
      <label v-for="d in video" :key="d.deviceId" class="form-radio">
        <input
          :id="d.deviceId"
          v-model="state.deviceVideo"
          type="radio"
          :value="d.deviceId"
        >
        <i class="form-icon" />
        {{ d.label }}
      </label>
    </div>
    <div v-if="audio.length" class="form-group settings-group">
      <label class="form-labelx"><b>{{ $t('settings.audio') }}</b></label>
      <label v-for="d in audio" :key="d.deviceId" class="form-radio">
        <input
          :id="d.deviceId"
          v-model="state.deviceAudio"
          type="radio"
          :value="d.deviceId"
        >
        <i class="form-icon" />
        {{ d.label }}
      </label>
    </div>
    <div class="form-group settings-group">
      <label>
        <input v-model="state.fill" type="checkbox" class="form-switch">
        {{ $t('settings.fill') }}
      </label>
      <div class="settings-info">
        {{ $t('settings.fill_info') }}
      </div>
    </div>
    <div v-if="false" class="form-group settings-group">
      <label>
        <input v-model="state.bandwidth" type="checkbox" class="form-switch">
        {{ $t('settings.bandwidth') }}
      </label>
      <div class="settings-info">
        {{ $t('settings.bandwidth_info') }}
      </div>
    </div>
    <div v-if="state.deviceVideo !== 'desktop'" class="form-group settings-group">
      <label class="form-labelx"><b>{{ $t('settings.background') }}</b></label>
      <label class="form-radio">
        <input
          v-model="state.backgroundMode"
          type="radio"
          value=""
        >
        <i class="form-icon" />
        {{ $t('settings.original_background') }}
      </label>
      <label class="form-radio">
        <input
          v-model="state.backgroundMode"
          type="radio"
          value="blur"
        >
        <i class="form-icon" />
        {{ $t('settings.blurred_background') }}
      </label>
      <label class="form-radio">
        <input
          v-model="state.backgroundMode"
          type="radio"
          value="image"
        >
        <i class="form-icon" />
        {{ $t('settings.image_background') }}
      </label>
      <div v-if="state.backgroundMode === 'image'" style="margin-top: 0.5rem;">
        <div v-if="state.backgroundImageURL" style="margin-bottom: 0.5rem;">
          <img :src="state.backgroundImageURL" style="max-width: 120px; border-radius: 4px;">
        </div>
        <label class="btn btn-sm">
          {{ $t('settings.upload_image') }}
          <input type="file" accept="image/*" hidden @change="onBackgroundImageUpload">
        </label>
      </div>
      <div v-if="state.backgroundMode" class="settings-info">
        {{ $t('settings.blur_info') }}
      </div>
    </div>
    <div v-if="enableSubscribe" class="form-group settings-group">
      <label>
        <input v-model="state.subscribe" type="checkbox" class="form-switch">
        {{ $t('settings.subscribe') }}
      </label>
      <div class="settings-info">
        {{ $t('settings.subscribe_info') }}
      </div>
    </div>
    <div v-if="false" class="form-group settings-group">
      <label>
        <input v-model="sentry" type="checkbox" class="form-switch">
        {{ $t('settings.sentry') }}
      </label>
      <div class="settings-info" v-html="$t('settings.sentry_info')" />
    </div>
    <div v-if="false" class="form-group settings-group">
      <label>
        <input v-model="sentry" type="checkbox" class="form-switch">
        {{ $t('settings.persist_settings') }}
      </label>
    </div>
    <!-- <pre>{{ state }}</pre> -->
    <div class="release-info">
      <a href="#" @click.prevent="showInfo = !showInfo">Server Info</a>
      |
      <a
        href="https://github.com/holtwick/briefing"
        target="_blank"
        rel="noopener"
        title="Open Github source code repository"
      >{{ release }}</a>
    </div>
    <div v-if="showInfo">
      <div class="form-group settings-group">
        <label class="form-labelx"><b>Signal Server</b></label>
        <div>{{ signalStatus }} {{ SIGNAL_SERVER_URL }}</div>
        <div>
          <a href="#" @click.prevent="doCheckSignal">Check Connectivity</a>
        </div>
      </div>
      <div class="form-group settings-group">
        <label class="form-labelx"><b>STUN / TURN Servers</b></label>
        <div v-for="(server, index) in ICE_CONFIG.iceServers" :key="index">
          {{ server.urls }}
        </div>
      </div>
    </div>
  </div>
</template>
