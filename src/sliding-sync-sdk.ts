/*
Copyright 2022 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { NotificationCountType, Room, RoomEvent } from "./models/room";
import { logger } from './logger';
import * as utils from "./utils";
import { EventTimeline } from "./models/event-timeline";
import { ClientEvent, IStoredClientOpts, MatrixClient, PendingEventOrdering } from "./client";
import { ISyncStateData, SyncState, _createAndReEmitRoom } from "./sync";
import { MatrixEvent } from "./models/event";
import { Crypto } from "./crypto";
import { IMinimalEvent, IRoomEvent, IStateEvent, IStrippedState } from "./sync-accumulator";
import { MatrixError } from "./http-api";
import {
    Extension,
    ExtensionState,
    MSC3575RoomData,
    MSC3575SlidingSyncResponse,
    SlidingSync,
    SlidingSyncEvent,
    SlidingSyncState,
} from "./sliding-sync";
import { EventType, IPushRules } from "./matrix";
import { PushProcessor } from "./pushprocessor";

// Number of consecutive failed syncs that will lead to a syncState of ERROR as opposed
// to RECONNECTING. This is needed to inform the client of server issues when the
// keepAlive is successful but the server /sync fails.
const FAILED_SYNC_ERROR_THRESHOLD = 3;

class ExtensionE2EE implements Extension {
    constructor(private readonly crypto: Crypto) {}

    public name(): string {
        return "e2ee";
    }

    public when(): ExtensionState {
        return ExtensionState.PreProcess;
    }

    public onRequest(isInitial: boolean): object | undefined {
        if (!isInitial) {
            return undefined;
        }
        return {
            enabled: true, // this is sticky so only send it on the initial request
        };
    }

    public async onResponse(data: object): Promise<void> {
        // Handle device list updates
        if (data["device_lists"]) {
            await this.crypto.handleDeviceListChanges({
                oldSyncToken: "yep", // XXX need to do this so the device list changes get processed :(
            }, data["device_lists"]);
        }

        // Handle one_time_keys_count
        if (data["device_one_time_keys_count"]) {
            const currentCount = data["device_one_time_keys_count"].signed_curve25519 || 0;
            this.crypto.updateOneTimeKeyCount(currentCount);
        }
        if (data["device_unused_fallback_key_types"] ||
                data["org.matrix.msc2732.device_unused_fallback_key_types"]) {
            // The presence of device_unused_fallback_key_types indicates that the
            // server supports fallback keys. If there's no unused
            // signed_curve25519 fallback key we need a new one.
            const unusedFallbackKeys = data["device_unused_fallback_key_types"] ||
                data["org.matrix.msc2732.device_unused_fallback_key_types"];
            this.crypto.setNeedsNewFallback(
                Array.isArray(unusedFallbackKeys) &&
                !unusedFallbackKeys.includes("signed_curve25519"),
            );
        }
    }
}

class ExtensionToDevice implements Extension {
    private nextBatch: string | null = null;

    constructor(private readonly client: MatrixClient) {}

    public name(): string {
        return "to_device";
    }

    public when(): ExtensionState {
        return ExtensionState.PreProcess;
    }

    public onRequest(isInitial: boolean): object {
        const extReq = {
            since: this.nextBatch !== null ? this.nextBatch : undefined,
        };
        if (isInitial) {
            extReq["limit"] = 100;
            extReq["enabled"] = true;
        }
        return extReq;
    }

    public async onResponse(data: object): Promise<void> {
        const cancelledKeyVerificationTxns: string[] = [];
        data["events"] = data["events"] || [];
        data["events"]
            .map(this.client.getEventMapper())
            .map((toDeviceEvent) => { // map is a cheap inline forEach
                // We want to flag m.key.verification.start events as cancelled
                // if there's an accompanying m.key.verification.cancel event, so
                // we pull out the transaction IDs from the cancellation events
                // so we can flag the verification events as cancelled in the loop
                // below.
                if (toDeviceEvent.getType() === "m.key.verification.cancel") {
                    const txnId: string | undefined = toDeviceEvent.getContent()['transaction_id'];
                    if (txnId) {
                        cancelledKeyVerificationTxns.push(txnId);
                    }
                }

                // as mentioned above, .map is a cheap inline forEach, so return
                // the unmodified event.
                return toDeviceEvent;
            })
            .forEach(
                (toDeviceEvent) => {
                    const content = toDeviceEvent.getContent();
                    if (
                        toDeviceEvent.getType() == "m.room.message" &&
                        content.msgtype == "m.bad.encrypted"
                    ) {
                        // the mapper already logged a warning.
                        logger.log(
                            'Ignoring undecryptable to-device event from ' +
                            toDeviceEvent.getSender(),
                        );
                        return;
                    }

                    if (toDeviceEvent.getType() === "m.key.verification.start"
                        || toDeviceEvent.getType() === "m.key.verification.request") {
                        const txnId = content['transaction_id'];
                        if (cancelledKeyVerificationTxns.includes(txnId)) {
                            toDeviceEvent.flagCancelled();
                        }
                    }

                    this.client.emit(ClientEvent.ToDeviceEvent, toDeviceEvent);
                },
            );

        this.nextBatch = data["next_batch"];
    }
}

class ExtensionAccountData implements Extension {
    constructor(private readonly client: MatrixClient) {}

    public name(): string {
        return "account_data";
    }

    public when(): ExtensionState {
        return ExtensionState.PostProcess;
    }

    public onRequest(isInitial: boolean): object | undefined {
        if (!isInitial) {
            return undefined;
        }
        return {
            enabled: true,
        };
    }

    public onResponse(data: {global: object[], rooms: Record<string, object[]>}): void {
        if (data.global && data.global.length > 0) {
            this.processGlobalAccountData(data.global);
        }

        for (const roomId in data.rooms) {
            const accountDataEvents = mapEvents(this.client, roomId, data.rooms[roomId]);
            const room = this.client.getRoom(roomId);
            if (!room) {
                logger.warn("got account data for room but room doesn't exist on client:", roomId);
                continue;
            }
            room.addAccountData(accountDataEvents);
            accountDataEvents.forEach((e) => {
                this.client.emit(ClientEvent.Event, e);
            });
        }
    }

    private processGlobalAccountData(globalAccountData: object[]): void {
        const events = mapEvents(this.client, undefined, globalAccountData);
        const prevEventsMap = events.reduce((m, c) => {
            m[c.getType()] = this.client.store.getAccountData(c.getType());
            return m;
        }, {});
        this.client.store.storeAccountDataEvents(events);
        events.forEach(
            (accountDataEvent) => {
                // Honour push rules that come down the sync stream but also
                // honour push rules that were previously cached. Base rules
                // will be updated when we receive push rules via getPushRules
                // (see sync) before syncing over the network.
                if (accountDataEvent.getType() === EventType.PushRules) {
                    const rules = accountDataEvent.getContent<IPushRules>();
                    this.client.pushRules = PushProcessor.rewriteDefaultRules(rules);
                }
                const prevEvent = prevEventsMap[accountDataEvent.getType()];
                this.client.emit(ClientEvent.AccountData, accountDataEvent, prevEvent);
                return accountDataEvent;
            },
        );
    }
}

/**
 * A copy of SyncApi such that it can be used as a drop-in replacement for sync v2. For the actual
 * sliding sync API, see sliding-sync.ts or the class SlidingSync.
 */
export class SlidingSyncSdk {
    private syncState: SyncState | null = null;
    private syncStateData?: ISyncStateData;
    private lastPos: string | null = null;
    private failCount = 0;
    private notifEvents: MatrixEvent[] = []; // accumulator of sync events in the current sync response

    constructor(
        private readonly slidingSync: SlidingSync,
        private readonly client: MatrixClient,
        private readonly opts: Partial<IStoredClientOpts> = {},
    ) {
        this.opts.initialSyncLimit = this.opts.initialSyncLimit ?? 8;
        this.opts.resolveInvitesToProfiles = this.opts.resolveInvitesToProfiles || false;
        this.opts.pollTimeout = this.opts.pollTimeout || (30 * 1000);
        this.opts.pendingEventOrdering = this.opts.pendingEventOrdering || PendingEventOrdering.Chronological;
        this.opts.experimentalThreadSupport = this.opts.experimentalThreadSupport === true;

        if (!opts.canResetEntireTimeline) {
            opts.canResetEntireTimeline = (_roomId: string) => {
                return false;
            };
        }

        if (client.getNotifTimelineSet()) {
            client.reEmitter.reEmit(client.getNotifTimelineSet()!, [
                RoomEvent.Timeline,
                RoomEvent.TimelineReset,
            ]);
        }

        this.slidingSync.on(SlidingSyncEvent.Lifecycle, this.onLifecycle.bind(this));
        this.slidingSync.on(SlidingSyncEvent.RoomData, this.onRoomData.bind(this));
        const extensions: Extension[] = [
            new ExtensionToDevice(this.client),
            new ExtensionAccountData(this.client),
        ];
        if (this.opts.crypto) {
            extensions.push(
                new ExtensionE2EE(this.opts.crypto),
            );
        }
        extensions.forEach((ext) => {
            this.slidingSync.registerExtension(ext);
        });
    }

    private onRoomData(roomId: string, roomData: MSC3575RoomData): void {
        let room = this.client.store.getRoom(roomId);
        if (!room) {
            if (!roomData.initial) {
                logger.debug("initial flag not set but no stored room exists for room ", roomId, roomData);
                return;
            }
            room = _createAndReEmitRoom(this.client, roomId, this.opts);
        }
        this.processRoomData(this.client, room, roomData);
    }

    private onLifecycle(state: SlidingSyncState, resp: MSC3575SlidingSyncResponse | null, err?: Error): void {
        if (err) {
            logger.debug("onLifecycle", state, err);
        }
        switch (state) {
            case SlidingSyncState.Complete:
                this.purgeNotifications();
                if (!resp) {
                    break;
                }
                // Element won't stop showing the initial loading spinner unless we fire SyncState.Prepared
                if (!this.lastPos) {
                    this.updateSyncState(SyncState.Prepared, {
                        oldSyncToken: undefined,
                        nextSyncToken: resp.pos,
                        catchingUp: false,
                        fromCache: false,
                    });
                }
                // Conversely, Element won't show the room list unless there is at least 1x SyncState.Syncing
                // so hence for the very first sync we will fire prepared then immediately syncing.
                this.updateSyncState(SyncState.Syncing, {
                    oldSyncToken: this.lastPos!,
                    nextSyncToken: resp.pos,
                    catchingUp: false,
                    fromCache: false,
                });
                this.lastPos = resp.pos;
                break;
            case SlidingSyncState.RequestFinished:
                if (err) {
                    this.failCount += 1;
                    this.updateSyncState(
                        this.failCount > FAILED_SYNC_ERROR_THRESHOLD ? SyncState.Error : SyncState.Reconnecting,
                        {
                            error: new MatrixError(err),
                        },
                    );
                    if (this.shouldAbortSync(new MatrixError(err))) {
                        return; // shouldAbortSync actually stops syncing too so we don't need to do anything.
                    }
                } else {
                    this.failCount = 0;
                }
                break;
        }
    }

    /**
     * Sync rooms the user has left.
     * @return {Promise} Resolved when they've been added to the store.
     */
    public async syncLeftRooms() {
        return []; // TODO
    }

    /**
     * Peek into a room. This will result in the room in question being synced so it
     * is accessible via getRooms(). Live updates for the room will be provided.
     * @param {string} roomId The room ID to peek into.
     * @return {Promise} A promise which resolves once the room has been added to the
     * store.
     */
    public async peek(_roomId: string): Promise<Room> {
        return null!; // TODO
    }

    /**
     * Stop polling for updates in the peeked room. NOPs if there is no room being
     * peeked.
     */
    public stopPeeking(): void {
        // TODO
    }

    /**
     * Returns the current state of this sync object
     * @see module:client~MatrixClient#event:"sync"
     * @return {?String}
     */
    public getSyncState(): SyncState | null {
        return this.syncState;
    }

    /**
     * Returns the additional data object associated with
     * the current sync state, or null if there is no
     * such data.
     * Sync errors, if available, are put in the 'error' key of
     * this object.
     * @return {?Object}
     */
    public getSyncStateData(): ISyncStateData | null {
        return this.syncStateData ?? null;
    }

    private shouldAbortSync(error: MatrixError): boolean {
        if (error.errcode === "M_UNKNOWN_TOKEN") {
            // The logout already happened, we just need to stop.
            logger.warn("Token no longer valid - assuming logout");
            this.stop();
            this.updateSyncState(SyncState.Error, { error });
            return true;
        }
        return false;
    }

    private async processRoomData(client: MatrixClient, room: Room, roomData: MSC3575RoomData) {
        roomData = ensureNameEvent(client, room.roomId, roomData);
        const stateEvents = mapEvents(this.client, room.roomId, roomData.required_state);
        // Prevent events from being decrypted ahead of time
        // this helps large account to speed up faster
        // room::decryptCriticalEvent is in charge of decrypting all the events
        // required for a client to function properly
        let timelineEvents = mapEvents(this.client, room.roomId, roomData.timeline, false);
        const ephemeralEvents = []; // TODO this.mapSyncEventsFormat(joinObj.ephemeral);

        // TODO: handle threaded / beacon events

        if (roomData.initial) {
            // we should not know about any of these timeline entries if this is a genuinely new room.
            // If we do, then we've effectively done scrollback (e.g requesting timeline_limit: 1 for
            // this room, then timeline_limit: 50).
            const knownEvents = new Set<string>();
            room.getLiveTimeline().getEvents().forEach((e) => {
                knownEvents.add(e.getId()!);
            });
            // all unknown events BEFORE a known event must be scrollback e.g:
            //       D E   <-- what we know
            // A B C D E F <-- what we just received
            // means:
            // A B C       <-- scrollback
            //       D E   <-- dupes
            //           F <-- new event
            // We bucket events based on if we have seen a known event yet.
            const oldEvents: MatrixEvent[] = [];
            const newEvents: MatrixEvent[] = [];
            let seenKnownEvent = false;
            for (let i = timelineEvents.length-1; i >= 0; i--) {
                const recvEvent = timelineEvents[i];
                if (knownEvents.has(recvEvent.getId()!)) {
                    seenKnownEvent = true;
                    continue; // don't include this event, it's a dupe
                }
                if (seenKnownEvent) {
                    // old -> new
                    oldEvents.push(recvEvent);
                } else {
                    // old -> new
                    newEvents.unshift(recvEvent);
                }
            }
            timelineEvents = newEvents;
            if (oldEvents.length > 0) {
                // old events are scrollback, insert them now
                room.addEventsToTimeline(oldEvents, true, room.getLiveTimeline(), roomData.prev_batch);
            }
        }

        const encrypted = this.client.isRoomEncrypted(room.roomId);
        // we do this first so it's correct when any of the events fire
        if (roomData.notification_count != null) {
            room.setUnreadNotificationCount(
                NotificationCountType.Total,
                roomData.notification_count,
            );
        }

        if (roomData.highlight_count != null) {
            // We track unread notifications ourselves in encrypted rooms, so don't
            // bother setting it here. We trust our calculations better than the
            // server's for this case, and therefore will assume that our non-zero
            // count is accurate.
            if (!encrypted
                || (encrypted && room.getUnreadNotificationCount(NotificationCountType.Highlight) <= 0)) {
                room.setUnreadNotificationCount(
                    NotificationCountType.Highlight,
                    roomData.highlight_count,
                );
            }
        }

        if (Number.isInteger(roomData.invited_count)) {
            room.currentState.setInvitedMemberCount(roomData.invited_count!);
        }
        if (Number.isInteger(roomData.joined_count)) {
            room.currentState.setJoinedMemberCount(roomData.joined_count!);
        }

        if (roomData.invite_state) {
            const inviteStateEvents = mapEvents(this.client, room.roomId, roomData.invite_state);
            this.processRoomEvents(room, inviteStateEvents);
            if (roomData.initial) {
                room.recalculate();
                this.client.store.storeRoom(room);
                this.client.emit(ClientEvent.Room, room);
            }
            inviteStateEvents.forEach((e) => {
                this.client.emit(ClientEvent.Event, e);
            });
            room.updateMyMembership("invite");
            return;
        }

        if (roomData.initial) {
            // set the back-pagination token. Do this *before* adding any
            // events so that clients can start back-paginating.
            room.getLiveTimeline().setPaginationToken(roomData.prev_batch ?? null, EventTimeline.BACKWARDS);
        }

        /* TODO
        else if (roomData.limited) {

            let limited = true;

            // we've got a limited sync, so we *probably* have a gap in the
            // timeline, so should reset. But we might have been peeking or
            // paginating and already have some of the events, in which
            // case we just want to append any subsequent events to the end
            // of the existing timeline.
            //
            // This is particularly important in the case that we already have
            // *all* of the events in the timeline - in that case, if we reset
            // the timeline, we'll end up with an entirely empty timeline,
            // which we'll try to paginate but not get any new events (which
            // will stop us linking the empty timeline into the chain).
            //
            for (let i = timelineEvents.length - 1; i >= 0; i--) {
                const eventId = timelineEvents[i].getId();
                if (room.getTimelineForEvent(eventId)) {
                    logger.debug("Already have event " + eventId + " in limited " +
                        "sync - not resetting");
                    limited = false;

                    // we might still be missing some of the events before i;
                    // we don't want to be adding them to the end of the
                    // timeline because that would put them out of order.
                    timelineEvents.splice(0, i);

                    // XXX: there's a problem here if the skipped part of the
                    // timeline modifies the state set in stateEvents, because
                    // we'll end up using the state from stateEvents rather
                    // than the later state from timelineEvents. We probably
                    // need to wind stateEvents forward over the events we're
                    // skipping.
                    break;
                }
            }

            if (limited) {
                room.resetLiveTimeline(
                    roomData.prev_batch,
                    null, // TODO this.opts.canResetEntireTimeline(room.roomId) ? null : syncEventData.oldSyncToken,
                );

                // We have to assume any gap in any timeline is
                // reason to stop incrementally tracking notifications and
                // reset the timeline.
                this.client.resetNotifTimelineSet();
            }
        } */

        this.processRoomEvents(room, stateEvents, timelineEvents, false);

        // we deliberately don't add ephemeral events to the timeline
        room.addEphemeralEvents(ephemeralEvents);

        // local fields must be set before any async calls because call site assumes
        // synchronous execution prior to emitting SlidingSyncState.Complete
        room.updateMyMembership("join");

        room.recalculate();
        if (roomData.initial) {
            client.store.storeRoom(room);
            client.emit(ClientEvent.Room, room);
        }

        // check if any timeline events should bing and add them to the notifEvents array:
        // we'll purge this once we've fully processed the sync response
        this.addNotifications(timelineEvents);

        const processRoomEvent = async (e: MatrixEvent) => {
            client.emit(ClientEvent.Event, e);
            if (e.isState() && e.getType() == EventType.RoomEncryption && this.opts.crypto) {
                await this.opts.crypto.onCryptoEvent(e);
            }
        };

        await utils.promiseMapSeries(stateEvents, processRoomEvent);
        await utils.promiseMapSeries(timelineEvents, processRoomEvent);
        ephemeralEvents.forEach(function(e) {
            client.emit(ClientEvent.Event, e);
        });

        // Decrypt only the last message in all rooms to make sure we can generate a preview
        // And decrypt all events after the recorded read receipt to ensure an accurate
        // notification count
        room.decryptCriticalEvents();
    }

    /**
     * @param {Room} room
     * @param {MatrixEvent[]} stateEventList A list of state events. This is the state
     * at the *START* of the timeline list if it is supplied.
     * @param {MatrixEvent[]} [timelineEventList] A list of timeline events. Lower index
     * @param {boolean} fromCache whether the sync response came from cache
     * is earlier in time. Higher index is later.
     */
    private processRoomEvents(
        room: Room,
        stateEventList: MatrixEvent[],
        timelineEventList?: MatrixEvent[],
        fromCache = false,
    ): void {
        timelineEventList = timelineEventList || [];
        stateEventList = stateEventList || [];

        // If there are no events in the timeline yet, initialise it with
        // the given state events
        const liveTimeline = room.getLiveTimeline();
        const timelineWasEmpty = liveTimeline.getEvents().length == 0;
        if (timelineWasEmpty) {
            // Passing these events into initialiseState will freeze them, so we need
            // to compute and cache the push actions for them now, otherwise sync dies
            // with an attempt to assign to read only property.
            // XXX: This is pretty horrible and is assuming all sorts of behaviour from
            // these functions that it shouldn't be. We should probably either store the
            // push actions cache elsewhere so we can freeze MatrixEvents, or otherwise
            // find some solution where MatrixEvents are immutable but allow for a cache
            // field.
            for (const ev of stateEventList) {
                this.client.getPushActionsForEvent(ev);
            }
            liveTimeline.initialiseState(stateEventList);
        }

        // If the timeline wasn't empty, we process the state events here: they're
        // defined as updates to the state before the start of the timeline, so this
        // starts to roll the state forward.
        // XXX: That's what we *should* do, but this can happen if we were previously
        // peeking in a room, in which case we obviously do *not* want to add the
        // state events here onto the end of the timeline. Historically, the js-sdk
        // has just set these new state events on the old and new state. This seems
        // very wrong because there could be events in the timeline that diverge the
        // state, in which case this is going to leave things out of sync. However,
        // for now I think it;s best to behave the same as the code has done previously.
        if (!timelineWasEmpty) {
            // XXX: As above, don't do this...
            //room.addLiveEvents(stateEventList || []);
            // Do this instead...
            room.oldState.setStateEvents(stateEventList);
            room.currentState.setStateEvents(stateEventList);
        }

        // execute the timeline events. This will continue to diverge the current state
        // if the timeline has any state events in it.
        // This also needs to be done before running push rules on the events as they need
        // to be decorated with sender etc.
        room.addLiveEvents(timelineEventList, {
            fromCache: fromCache,
        });

        room.recalculate();

        // resolve invites now we have set the latest state
        this.resolveInvites(room);
    }

    private resolveInvites(room: Room): void {
        if (!room || !this.opts.resolveInvitesToProfiles) {
            return;
        }
        const client = this.client;
        // For each invited room member we want to give them a displayname/avatar url
        // if they have one (the m.room.member invites don't contain this).
        room.getMembersWithMembership("invite").forEach(function(member) {
            if (member.requestedProfileInfo) return;
            member.requestedProfileInfo = true;
            // try to get a cached copy first.
            const user = client.getUser(member.userId);
            let promise: ReturnType<MatrixClient["getProfileInfo"]>;
            if (user) {
                promise = Promise.resolve({
                    avatar_url: user.avatarUrl,
                    displayname: user.displayName,
                });
            } else {
                promise = client.getProfileInfo(member.userId);
            }
            promise.then(function(info) {
                // slightly naughty by doctoring the invite event but this means all
                // the code paths remain the same between invite/join display name stuff
                // which is a worthy trade-off for some minor pollution.
                const inviteEvent = member.events.member!;
                if (inviteEvent.getContent().membership !== "invite") {
                    // between resolving and now they have since joined, so don't clobber
                    return;
                }
                inviteEvent.getContent().avatar_url = info.avatar_url;
                inviteEvent.getContent().displayname = info.displayname;
                // fire listeners
                member.setMembershipEvent(inviteEvent, room.currentState);
            }, function(_err) {
                // OH WELL.
            });
        });
    }

    public retryImmediately(): boolean {
        return true;
    }

    /**
     * Main entry point. Blocks until stop() is called.
     */
    public async sync() {
        logger.debug("Sliding sync init loop");

        //   1) We need to get push rules so we can check if events should bing as we get
        //      them from /sync.
        while (!this.client.isGuest()) {
            try {
                logger.debug("Getting push rules...");
                const result = await this.client.getPushRules();
                logger.debug("Got push rules");
                this.client.pushRules = result;
                break;
            } catch (err) {
                logger.error("Getting push rules failed", err);
                if (this.shouldAbortSync(<MatrixError>err)) {
                    return;
                }
            }
        }

        // start syncing
        await this.slidingSync.start();
    }

    /**
     * Stops the sync object from syncing.
     */
    public stop(): void {
        logger.debug("SyncApi.stop");
        this.slidingSync.stop();
    }

    /**
     * Sets the sync state and emits an event to say so
     * @param {String} newState The new state string
     * @param {Object} data Object of additional data to emit in the event
     */
    private updateSyncState(newState: SyncState, data?: ISyncStateData): void {
        const old = this.syncState;
        this.syncState = newState;
        this.syncStateData = data;
        this.client.emit(ClientEvent.Sync, this.syncState, old, data);
    }

    /**
     * Takes a list of timelineEvents and adds and adds to notifEvents
     * as appropriate.
     * This must be called after the room the events belong to has been stored.
     *
     * @param {MatrixEvent[]} [timelineEventList] A list of timeline events. Lower index
     * is earlier in time. Higher index is later.
     */
    private addNotifications(timelineEventList: MatrixEvent[]): void {
        // gather our notifications into this.notifEvents
        if (!this.client.getNotifTimelineSet()) {
            return;
        }
        for (const timelineEvent of timelineEventList) {
            const pushActions = this.client.getPushActionsForEvent(timelineEvent);
            if (pushActions && pushActions.notify &&
                pushActions.tweaks && pushActions.tweaks.highlight) {
                this.notifEvents.push(timelineEvent);
            }
        }
    }

    /**
     * Purge any events in the notifEvents array. Used after a /sync has been complete.
     * This should not be called at a per-room scope (e.g in onRoomData) because otherwise the ordering
     * will be messed up e.g room A gets a bing, room B gets a newer bing, but both in the same /sync
     * response. If we purge at a per-room scope then we could process room B before room A leading to
     * room B appearing earlier in the notifications timeline, even though it has the higher origin_server_ts.
     */
    private purgeNotifications(): void {
        this.notifEvents.sort(function(a, b) {
            return a.getTs() - b.getTs();
        });
        this.notifEvents.forEach((event) => {
            this.client.getNotifTimelineSet()?.addLiveEvent(event);
        });
        this.notifEvents = [];
    }
}

function ensureNameEvent(client: MatrixClient, roomId: string, roomData: MSC3575RoomData): MSC3575RoomData {
    // make sure m.room.name is in required_state if there is a name, replacing anything previously
    // there if need be. This ensures clients transparently 'calculate' the right room name. Native
    // sliding sync clients should just read the "name" field.
    if (!roomData.name) {
        return roomData;
    }
    for (const stateEvent of roomData.required_state) {
        if (stateEvent.type === EventType.RoomName && stateEvent.state_key === "") {
            stateEvent.content = {
                name: roomData.name,
            };
            return roomData;
        }
    }
    roomData.required_state.push({
        event_id: "$fake-sliding-sync-name-event-" + roomId,
        state_key: "",
        type: EventType.RoomName,
        content: {
            name: roomData.name,
        },
        sender: client.getUserId()!,
        origin_server_ts: new Date().getTime(),
    });
    return roomData;
}

// Helper functions which set up JS SDK structs are below and are identical to the sync v2 counterparts,
// just outside the class.

function mapEvents(client: MatrixClient, roomId: string | undefined, events: object[], decrypt = true): MatrixEvent[] {
    const mapper = client.getEventMapper({ decrypt });
    return (events as Array<IStrippedState | IRoomEvent | IStateEvent | IMinimalEvent>).map(function(e) {
        e["room_id"] = roomId;
        return mapper(e);
    });
}
