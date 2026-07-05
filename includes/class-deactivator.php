<?php
/**
 * Fired during plugin deactivation.
 */

if (! defined('ABSPATH')) {
    exit;
}

class ST_Sync_Deactivator
{

    /**
     * Clear rewrite rules so our CPT routes are removed from the DB.
     *
     * @return void
     */
    public static function deactivate(): void
    {
        flush_rewrite_rules();
    }
}
