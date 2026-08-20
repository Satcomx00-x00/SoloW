/**
 * Every module that contributes to a surface, imported for its registrations (issue #3).
 *
 * Registration is a module side effect, so something has to keep these modules in the bundle.
 * A surface importing its contributors would be exactly the coupling the registries remove, so
 * surfaces import this barrel instead and adding a contributor is one line here rather than an
 * edit to the palette or the status bar. It is also the file a plugin loader replaces in #93:
 * the same list, discovered at runtime instead of written down.
 */
import "@/components/features/settings/settings-commands";
import "@/components/features/status-bar/status-items";
import "@/lib/navigation-commands";
import "@/lib/notification-channels";
