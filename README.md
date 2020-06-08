# rotatest

componentDidMount() {
    this.getAlerts()

    if (
      !accessAuthorizations().includes(AUTHORIZED_PAGE_MONITORING) &&
      !accessProfiles().includes('monitoring')
    ) {
      return this.props.replace('/404')
    }

    subscribe([this.props.auth.realtime_channel_name])

    on('events', this.addEvent)
  }
