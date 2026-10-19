-- The rebuilt blobs table (0017) lost the revoke from 0007: only the system role may touch blobs.
REVOKE ALL ON "blobs" FROM autodev_app;
