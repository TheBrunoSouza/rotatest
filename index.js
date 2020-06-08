import React, { PureComponent } from 'react'
import PropTypes from 'prop-types'
import { connect } from 'react-redux'
import { replace, push } from 'react-router-redux'
import { DragDropContext } from 'react-beautiful-dnd'
import moment from 'services/dates'
import { actions as toastr } from 'data/toastr'
import { withFormik } from 'formik'

import { Wrapper, Button, MultipleSelect, Input, Modal } from 'components'
import { AlertContainer, Resolution, AddAlert } from './components'

import { urlToParams } from 'services/fp'
import fetch, { requestOption, fetchConfig } from 'services/fetch'
import { subscribe, on } from 'services/socket'
import {
  accessProfiles,
  accessAuthorizations,
  AUTHORIZED_PAGE_MONITORING,
} from 'services/auth'

let timeout

class TrackablesType extends PureComponent {
  static contextTypes = {
    translate: PropTypes.func,
  }

  state = {
    alerts: [],
    open: [],
    pending: [],
    done: [],
    muted: true,
    offlineTimeoutGeofences: {},
    processAlert: {},
    modalOpen: false,
    labelProcess: '',
  }

  filterAlerts = [
    {
      label: this.context.translate('Aberto'),
      value: 'open',
    },
    {
      label: this.context.translate('Em atendimento'),
      value: 'pending',
    },
    {
      label: this.context.translate('Resolvido'),
      value: 'done',
    },
  ]

  onChange = (value, { name }) => this.props.setFieldValue(name, value)

  /*function that filters or processes, whether grouped or not, before moving to the onDrop function, 
  which updates or alerts and sets the states*/
  onDropSelection = async item => {

    const alert = this.state.alerts[item.draggableId]

    if(alert && alert.disregardedAlerts && item.destination.droppableId === 'done'){
      this.setState({modalOpen: true})
      //console.log('::: FINALIZANDO ALERTA AGRUPADO :::')
      await Promise.all(
        Object.values(alert.disregardedAlerts).reduce((memo, curr, index) => {
          memo.push(
            new Promise(async resolve => { 
              setTimeout(async () => {
                this.setState({labelProcess: 'Aguarde... Resolvendo ' + (index + 1) + ' de '+ Object.values(alert.disregardedAlerts).length})
                //console.log('curr', curr, index)
                const result = await this.onDrop({
                  ...item,
                  draggableId: curr.id,
                })
                resolve(result)
                }, (index === 0 ? 1000 : 2000 * (index + 1)))
              })
            )
          return memo
        }, [])
      )
      this.setState({labelProcess: '', modalOpen: false})
    }else{
      //console.log('::: FINALIZANDO NORMAL :::')
      this.onDrop(item)
    }
  }

  //onDrop is called directly in resolutions
  onDrop = async item => {
    if (timeout && timeout.flush) {
      timeout.flush()
    }

    const alert = this.state.alerts[item.draggableId]

    if (
      !item.destination ||
      !item.destination.droppableId ||
      item.destination.droppableId === item.source.droppableId// ||
      //!alert
    ) {
      return
    }

    this.updateAlert(item.draggableId, item.destination.droppableId)

    //If they are grouped events, they do not need to perform the rest, they have already been executed for the root event
    if(!alert)return
        
    //obs: when returning from finished, disregardedAlerts is empty, as the other alerts have already been closed. If the user wants to return, he will only use the root alert
    if(item.source.droppableId === 'done' && alert.disregardedAlerts){
      delete alert.disregardedAlerts
    }

    const newItem = {
      ...alert,
      user: this.props.auth.user,
      status: item.destination.droppableId,
      last_change: moment(),
      ...(item && item.destination && item.destination.droppableId === 'done' ? {resolved_at: moment().format('YYYY-MM-DD HH:mm:ss')} : {}),
    }

    this.setState({
      changed: item.draggableId,
      hovering: false,
      [item.source.droppableId]: this.state[item.source.droppableId].filter(
        alert => item.draggableId !== alert.id
      ),
      [item.destination.droppableId]: [
        ...(item.destination.droppableId === 'done' && (item.draggableId === item.eventId || !item.eventId) ? [newItem] : []),
        ...this.state[item.destination.droppableId],
        ...(item.destination.droppableId !== 'done' && (item.draggableId === item.eventId || !item.eventId) ? [newItem] : []),
      ],
      alerts: {
        ...this.state.alerts,
        [item.draggableId]: {
          ...newItem
        }
      },
    })

    timeout = setTimeout(() => this.setState({ changed: null }), 3000)
  }

  onClick = () => {
    this.setState({ modalOpen: true })

    //setTimeout(() => {
      //this.props.logout()
    //}, 2000)
  }

  toggleResolution = alert => {
    this.setState({
      closed: null,
      onEdit: alert,
    })
    this.props.push(`/app/monitoring/live${alert ? `?alert=${alert.id}` : ''}`)
  }

  toggleNew = () =>
    this.setState({
      creating: !this.state.creating,
    })

  updateAlert = async (id, status) => {
    this.setState({ updatingAlert: id })

    try {
      const data = await fetch(
        requestOption(
          {
            url: `alerts/${id}`,
            method: 'put',
            data: { id, status },
          },
          this.props.auth.token
        )
      )
      this.setState({updateAlert: null})
      return data
    } catch (error) {
      console.error(error)
      this.setState({ updatingAlert: null })
      this.props.showToastr({
        type: 'danger',
        text: this.context.translate('Ocorreu um erro na conexão com a API para salvar o atendimento. Atualize a página e tente novamente. Caso persista o erro, acione o TI.'),
      })
    }
  }

  getAlerts = async () => {
    this.setState({ loadingAlerts: true })

    try {
      const { data } = await fetch(
        requestOption({ url: 'alerts?' }, this.props.auth.token)
      )

      //console.log('data', data)

      //Filter alerts to restrict according to eventless_filter
      let requestBody = []
      let alerts = {}
      let alertsLatLng = data.reduce((memo, curr) => {
        if (!curr.lat || !curr.lng) {
          alerts[curr.id] = curr
          return memo
        }

        requestBody.push({
          lat: curr.lat,
          lng: curr.lng,
        })

        /*const id = `${curr.lat}${curr.lng}`
        memo[id] = curr*/

        memo[curr.id] = curr
        return memo
      }, {})

      let checkGeofences = []

      try {
        const { data } = await fetch(
          requestOption(
            {
              url: `geofences/eventless_filter`,
              method: 'post',
              data: {
                points: requestBody
              },
            },
            this.props.auth.token
          )
        )
        checkGeofences = data
      } catch (e) {
        console.error('getEventlessGeofences', e)
      }

      //console.log('checkGeofences', checkGeofences)

      //for each lat and lng, if there is eventless_geofences_ids we remove the alert from the list
      checkGeofences.forEach(check => {
        if (check.eventless_geofences_ids && check.eventless_geofences_ids.length) {
          /*delete alertsLatLng[`${check.lat}${check.lng}`]*/

          alertsLatLng = Object.values(alertsLatLng).reduce((memo, curr) => {
            if(curr.lat !== check.lat && curr.lng !== check.lng){
              memo[curr.id] = curr
            }
            return memo
          }, {})
        }
      })

      /*alertsLatLng = Object.values(alertsLatLng).reduce((memo, curr) => {
        memo[curr.id] = curr
        return memo
      }, {})*/

      alerts = {
        ...alerts,
        ...alertsLatLng
      }
      //end control eventless_filter
      //console.log('alerts', alerts)

      //Control for alerts grouping and put all same time
      const agroupAlerts = Object.values(alerts).reduce((memo, curr) => {
        const firstAlert = Object.values(memo).find(element => element.uin === curr.uin && (element.kind_in_words === curr.kind_in_words || element.kind === curr.kind) && (element.status === 'pending' || element.status === 'open') && curr.status !== 'done')
        if(firstAlert){          

          //When too many alerts, block at most 50
          if(Object.values(firstAlert.disregardedAlerts ? firstAlert.disregardedAlerts : {}).length === 50){
            console.log('total de alertas agrupados')
            return memo
          } 

          const aux = (firstAlert.disregardedAlerts ? firstAlert.disregardedAlerts : {[firstAlert.id]: memo[firstAlert.id]})
          memo[firstAlert.id] = {
            ...memo[firstAlert.id],
            disregardedAlerts: {...aux, [curr.id]: curr}
          }
        }else{
          memo[curr.id] = curr
        }
      
        return memo
      }, {})

      alerts = {...agroupAlerts} 
      //console.log('alerts', alerts)

      let offlineTimeoutGeofences = {...this.state.offlineTimeoutGeofences}

      /*Organizing alerts, keeping in uniqueGeofences only those alerts with no signal and that have a fence to consult the
      description of the fence to which they are attached*/
      let uniqueGeofences = Object.values({...alerts}).reduce((memo, curr) => {
        if (!curr.kind_id || curr.kind !== 'offline_timeout') {
          return memo
        }

        if (!memo.hasOwnProperty(curr.kind_id)) {
          memo[curr.kind_id] = { kind_id: curr.kind_id, alerts: [curr] }
        } else {
          memo[curr.kind_id].alerts.push(curr)
        }

        return memo
      }, {})

      await Promise.all(
        Object.values(uniqueGeofences).map(
          groupedAlerts =>
            new Promise(async resolve => {
              try {
                //Testing if the unsigned and fenced alerts, captured by getAlert, are no longer in the state. If not, data about
                if (!offlineTimeoutGeofences.hasOwnProperty(groupedAlerts.kind_id)) {
                  const { data } = await fetch(
                    requestOption({ url: `geofences/${groupedAlerts.kind_id}` }, this.props.auth.token)
                  )
                  offlineTimeoutGeofences[groupedAlerts.kind_id] = {...data}
                }

                //Updating the 'alerts' geofence_timeout field with the fence, state, or survey data above
                groupedAlerts.alerts.map(alert =>(
                  alerts[alert.id].geofence_timeout = offlineTimeoutGeofences[alert.kind_id]
                ))

                resolve()
              } catch (e) {
                console.log('getAlertGeofences', e)
                resolve()
              }
            })
        )
      )

      const status = Object.values(alerts).reduce((memo, curr) => {
        memo[curr.status].push(curr)
        return memo
      }, {
        open: [],
        pending: [],
        done: []
      })

      this.setState({
        offlineTimeoutGeofences,
        alerts: alerts,
        open:
          status.open.sort((a, b) => moment(a.gps_time) - moment(b.gps_time)),
        pending:
          status.pending.sort((a, b) => moment(a.gps_time) - moment(b.gps_time)),
        done:
          status.done.sort((a, b) => moment(b.resolved_at) - moment(a.resolved_at)),
        loadingAlerts: false,
      })

      const qsParams = urlToParams(this.props.location.search)
      if (qsParams.alert && alerts.hasOwnProperty(qsParams.alert)) {
        this.toggleResolution(alerts[qsParams.alert])
      }
    } catch (error) {
      console.error(error)
      this.setState({ loadingAlerts: false })
      this.props.showToastr({
        type: 'danger',
        text: this.context.translate('Ocorreu um erro ao consultar as APIs! Tente novamente e caso persista o erro, acione o TI.'),
      })
    }
  }

  addAlert = data => this.addEvent(data, true)

  getAlert = async alert => {
    try {
      const options = { 
        baseURL: `${fetchConfig.protocol}://${fetchConfig.host}/v1/rotasystems/${fetchConfig.version}`,
        url: `alerts/${alert.id}/cached`,
      }

      const { data } = await fetch(requestOption(options, this.props.auth.token))

      return data
    } catch (e) {
      console.log('getAlert fail', e)
      return alert
    }
  }

  getFullAlert = async alert => {
    if (!alert.tracker || !alert.tracker.vehicle) {
      alert = await this.getAlert(alert)
    }

    if (alert.lat && alert.lng) {
      let checkGeofences = []

      try {
        const { data } = await fetch(
          requestOption(
            {
              //url: `geofences/eventless_filter`,
              url: `rotasystems/v1/geofences/eventless_filter`,
              method: 'post',
              data: {
                points: [{
                  lat: alert.lat,
                  lng: alert.lng,
                }]
              },
            },
            this.props.auth.token
          )
        )
        checkGeofences = data
      } catch (e) {
        console.log('getEventlessGeofences', e)
      }

      (checkGeofences || []).forEach(check => {
        if (
          check.eventless_geofences_ids 
          && check.eventless_geofences_ids.length
          && alert.lat === check.lat
          && alert.lng === check.lng
        ) {
          return false
        }
      })
    }

    if (!alert.kind_id || alert.kind !== 'offline_timeout') {
      return alert
    }

    try {
      if (this.state.offlineTimeoutGeofences.hasOwnProperty(alert.kind_id)) {
        const { data } = await fetch(
          requestOption({ url: `geofences/${alert.kind_id}` }, this.props.auth.token)
        )

        this.setState({
          offlineTimeoutGeofences: {
            ...this.state.offlineTimeoutGeofences,
            [data.id]: data
          }
        })

        alert.geofence_timeout = data
      } else {
        alert.geofence_timeout = this.state.offlineTimeoutGeofences[alert.kind_id]
      }

      return alert
    } catch (e) {
      console.log('getFullAlert fail', e)
      return alert
    }
  }

  addEvent = async (data, parsedObject) => {
    //console.log('PROCESSANDO?', this.state.processAlert)
    let timeForProcess = this.state.processAlert && this.state.processAlert.uin === data.uin && this.state.processAlert.id !== data.id ? 5000 : 0

    //console.log('TEMPO?', timeForProcess)
    //setTimeout(async () => {
      this.setState({processAlert: data})
      let fullAlert = {}
      const status = data.resolved_at ? 'done' : data.status ? 'pending' : 'open'
      //console.log('status', status)
      //console.log('data', data)

      //Querying whether the alert is recurring and capturing the first
      const firstAlert = Object.values({...this.state.alerts}).find(element => element.uin === data.uin && (element.kind_in_words === data.kind_in_words || element.kind === data.kind) && (element.status === 'pending' || element.status === 'open'))    

      if(firstAlert && (firstAlert.id !== data.id || firstAlert.disregardedAlerts)/* && !validationDone*/){
        //console.log('::: ALERTA AGRUPADO ::: Agrupando em:', firstAlert)
        //console.log('state', this.state)

        //When too many alerts, block at most 50
        if(Object.values(firstAlert.disregardedAlerts ? firstAlert.disregardedAlerts : {}).length === 50){
          //console.log('total de alertas agrupados')
          this.setState({processAlert: null})
          return
        } 
        
        /*Including in the state the event that has just arrived, associated with the root event (first event generated)
        Within the main event there will be all other events that are generated within disregardedAlerts, including the root event (first)*/
        const disregardedAlerts = (firstAlert.disregardedAlerts ? firstAlert.disregardedAlerts : {[firstAlert.id]: firstAlert})
        const newEvent = {
          [firstAlert.id]: {
            ...firstAlert,
            disregardedAlerts: {...disregardedAlerts, [data.id]: data}
          }
        }

        const newAlerts = {
          ...this.state.alerts,
          ...newEvent,
        }

        //console.log('total de alertas agrupados anteriormente:', Object.values(firstAlert.disregardedAlerts ? firstAlert.disregardedAlerts : {}).length)
        //console.log('total de alertas agrupados agora:', Object.values(newEvent[firstAlert.id].disregardedAlerts).length)

        let auxState = {}

        //When it's a different event = number of grouped alerts has changed
        if(Object.values(newEvent[firstAlert.id].disregardedAlerts).length !== Object.values(firstAlert.disregardedAlerts ? firstAlert.disregardedAlerts : {}).length){
          //if((firstAlert.kind_in_words === 'Help desk' && firstAlert.status === 'open' && data.status === 'pending')){
            //auxState = {}
          //}else{
            //Apenas atualizando o status do evento raiz (primeiro)
            auxState = {
              [firstAlert.status]: [
                ...(this.state[firstAlert.status].filter(
                  event => event.id !== firstAlert.id
                )),
                ...[{
                  ...firstAlert,
                  disregardedAlerts: {...disregardedAlerts, [data.id]: data}
                }]
              ],
              alerts: newAlerts
            }
          //}
        }else{
          //Events with the same id may arrive, if the status is not changed, nothing will be done.
          if(firstAlert.status === status /*|| (firstAlert.kind_in_words === 'Help desk' && firstAlert.status === 'open' && data.status === 'pending')*/){
            auxState = {}
          }else{
            //Variable to update the state, removing the root status, including it in the new one and updating alerts
            const auxStateData = {
              ...firstAlert,
              disregardedAlerts: {...disregardedAlerts, [data.id]: data},
              status: status,
              last_change: moment(),
              user: {
                id: data.user_id,
                name: data.user_name,
              },
              ...(status === 'done' ? {resolved_at: moment().format('YYYY-MM-DD HH:mm:ss')} : {})
            }
            auxState = {
              [firstAlert.status]: [
                ...(this.state[firstAlert.status].filter(
                  event => event.id !== firstAlert.id
                )),
              ],
              [status]: [
                ...(this.state[status].filter(
                  event => event.id !== firstAlert.id
                )),
                ...[{
                  ...auxStateData
                }]
              ],
              alerts: {
                ...this.state.alerts,
                [firstAlert.id]: {
                  ...auxStateData
                }
              },
            }
          }
        }

        //console.log('aux', auxState)

        this.setState({
          changed: firstAlert.id,
          ...auxState
        })
      }else{
        //console.log('::: ALERTA NORMAL ::: ')
        const found = this.state.alerts[data.id]
        //console.log('found', found)      

        /*Special control for grouped and closed alerts:
        When we finalize an alert, the finalists pass one by one here too, since they have been updated by the socket. We control that they are not inserted again, one by one, in done,
        as they arrive, because in done we have previously inserted our grouped alert
        First we search for all found in done (same control done in getAlerts for open and pending)
        */
        const foundDisregardedDone = this.state[status].filter(element => element.uin === data.uin && element.kind_in_words === data.kind_in_words && element.disregardedAlerts)
        //console.log('buscando em done...', foundDisregardedDone)
        //After having all of the same uin and type, we search within disregardedAlerts, because the alert can be root or grouped
        const existDisregarded = foundDisregardedDone.reduce((memo, curr) => {
          if(curr.disregardedAlerts && curr.disregardedAlerts.hasOwnProperty(data.id)){
            memo.push(curr.disregardedAlerts[data.id])
          }
          return memo
        }, [])
        //console.log('encontrado em done...', existDisregarded)
        if(existDisregarded && existDisregarded.length > 0){
          this.setState({processAlert: null})
          //console.log('return - o alerta já está em done')
          return
        }

        if (!parsedObject) {
          if (
            !found 
            || !found.tracker 
            || !found.tracker.vehicle 
            || !found.tracker.vehicle.plate
          ) {
            fullAlert = await this.getFullAlert(data)
    
            if (fullAlert === false) {
              return
            }
          } else {
            data.tracker = {...found.tracker}
          }
        }

        const newEvent = {
          ...data,
          ...(status === 'done' ? {resolved_at: moment().format('YYYY-MM-DD HH:mm:ss')} : {}),
          ...(found ? { last_change: moment() } : {}),
          isNew: true,
          gps_time: data.gps_time || data.created_at,
          user: {
            id: data.user_id,
            name: data.user_name,
          },
          company: {
            name: data.tracker_name_with_company
              ? data.tracker_name_with_company.split('-')[0]
              : data.company_name
              ? data.company_name
              : '',
          },
          ...fullAlert,
          status,
        }
    
        const alert = parsedObject ? data : newEvent
        const alerts = {
          ...this.state.alerts,
          [alert.id]: alert
        }
        
        //console.log('STATE ANTES DE ATUALIZAR', this.state)
        const foundStatus = this.state[status].find(alert => alert.id === data.id)
        //console.log('foundStatus', foundStatus)
        this.setState({
          ...(found && !foundStatus
            ? {
                [found.status]: this.state[found.status].filter(
                  event => event.id !== found.id
                ),
              }
            : {}),
          [status]: [
            ...this.state[status],
            /*...{
              [status]: this.state[status].filter(
                event => event.id !== data.id || event.uin !== data.uin && event.kind_in_words !== data.kind_in_words
              ) 
            },*/
            ...(foundStatus ? [] : [alert]),
          ],
          alerts,
          changed: alert.id,
        })
      }
      timeout = setTimeout(() => this.setState({ changed: null }), 3000)
      //console.log('STATE APÓS', this.state)
      //console.log('------------------------FIM!-------------------------', data.id)
      this.setState({processAlert: null})
    //}, 5000)    
  }

  setHovering = name =>
    this.state.hovering !== name && this.setState({ hovering: name })

  componentDidUpdate(prevProps, prevState) {
    if (prevState.onEdit && !this.state.onEdit) {
      this.setState({
        closed: prevState.onEdit.id,
      })
    }
  }

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

  filter = (alert, filter) =>
    alert.kind.toLowerCase().includes(filter.toLowerCase()) ||
    (alert.tracker &&
      alert.tracker.vehicle &&
      alert.tracker.vehicle.name &&
      alert.tracker.vehicle.name
        .toLowerCase()
        .includes(filter.toLowerCase())) ||
    (alert.tracker &&
      alert.tracker.uin &&
      `${alert.tracker.uin}`.includes(filter.toLowerCase())) ||
    (alert.kind_in_words &&
      alert.kind_in_words.toLowerCase().includes(filter.toLowerCase())) ||
    (alert.user &&
      alert.user.name &&
      alert.user.name.toLowerCase().includes(filter.toLowerCase()))

  render() {
    const { translate } = this.context
    const { values, handleChange } = this.props
    const {
      open,
      done,
      muted,
      closed,
      onEdit,
      changed,
      pending,
      hovering,
      creating,
      loadingAlerts,
      modalOpen,
      labelProcess,
    } = this.state

    return (
      <Wrapper flexbox flex column scroll>
        <Wrapper flexbox width="100%" padding justify="space-between">
          <Wrapper fontSize="huge">{translate('Monitoramento')}</Wrapper>
          <Wrapper flexbox flex justify="flex-end">
            <Wrapper flexbox center>
              <Wrapper color="text">{translate('Filtros')}</Wrapper>
              <MultipleSelect
                name="filter_alerts"
                label={translate('Tipos')}
                value={values.filter_alerts}
                options={this.filterAlerts}
                onChange={this.onChange}
                margin="horizontal"
              />
              <Input
                name="filter"
                label={translate('Filtro')}
                value={values.filter}
                onChange={handleChange}
              />
            </Wrapper>
            <Wrapper flexbox margin="horizontal" center color="text">
              -
            </Wrapper>
            <Button type="button" color="success" onClick={this.toggleNew}>
              {translate('Novo atendimento')}
            </Button>
          </Wrapper>
        </Wrapper>
        <DragDropContext onDragEnd={this.onDropSelection}>
          <Wrapper flexbox flex scroll padding="noTop">
            <AlertContainer
              name="open"
              data={
                values.filter_alerts.includes('open')
                  ? open.filter(alert => this.filter(alert, values.filter))
                  : open
              }
              muted={muted}
              color="danger"
              onEdit={onEdit}
              closed={closed}
              changed={changed}
              isLoading={loadingAlerts}
              hover={hovering}
              title={translate('Aberto')}
              setHovering={this.setHovering}
              toggleResolution={this.toggleResolution}
            />
            <AlertContainer
              name="pending"
              color="info"
              margin="noTop"
              data={
                values.filter_alerts.includes('pending')
                  ? pending.filter(alert => this.filter(alert, values.filter))
                  : pending
              }
              onEdit={onEdit}
              closed={closed}
              changed={changed}
              isLoading={loadingAlerts}
              hover={hovering}
              setHovering={this.setHovering}
              title={translate('Em atendimento')}
              toggleResolution={this.toggleResolution}
            />
            <AlertContainer
              name="done"
              data={
                values.filter_alerts.includes('done')
                  ? done.filter(alert => this.filter(alert, values.filter))
                  : done
              }
              color="success"
              onEdit={onEdit}
              changed={changed}
              isLoading={loadingAlerts}
              hover={hovering}
              setHovering={this.setHovering}
              title={translate('Resolvido')}
              toggleResolution={this.toggleResolution}
            />
          </Wrapper>
        </DragDropContext>
        <Resolution
          onEdit={onEdit}
          onDrop={this.onDrop}
          auth={this.props.auth.user}
          token={this.props.auth.token}
          realtime_channel_name={this.props.auth.realtime_channel_name}
          onClose={this.toggleResolution}
          showToastr={this.props.showToastr}
        />
        {creating && (
          <AddAlert
            isOpen={creating}
            user={this.props.auth.user}
            token={this.props.auth.token}
            onClose={this.toggleNew}
            onAdd={this.addAlert}
            showToastr={this.props.showToastr}
            toggleResolution={this.toggleResolution}
          />
        )}
        <Modal open={modalOpen}>
          <Wrapper flexbox flex column padding>
            <Wrapper strong padding="horizontal" fontSize="16px">
              {labelProcess ? labelProcess : ''}
            </Wrapper>
          </Wrapper>
        </Modal>
      </Wrapper>
    )
  }
}

const mapForm = {
  mapPropsToValues: () => ({
    filter_alerts: [],
    filter: '',
  }),
}

const mapState = state => ({
  auth: {
    user: state.auth.data.user,
    realtime_channel_name: state.auth.data.realtime_channel_name,
    token: state.auth.data.token,
  },
})

const mapDispatch = {
  replace,
  push,
  showToastr: toastr.show,
}

export default connect(
  mapState,
  mapDispatch
)(withFormik(mapForm)(TrackablesType))
